"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useSupabaseClient } from "@/lib/supabase/client";
import {
  connectionAfterJoinTimeout,
  connectionFromChannelStatus,
  REALTIME_JOIN_TIMEOUT_MS,
  type RealtimeConnectionState,
} from "@/lib/ui/realtime-status";
import { messageRowSchema, type MessageRow } from "@/lib/inbox";
import { InboxEmptyState } from "./inbox-empty";
import { SimulatorCard } from "./simulator-card";
import {
  ConversationList,
  ConversationRail,
  ConversationThread,
  ThreadPlaceholder,
  deriveConversationState,
  useIsDesktopPane,
} from "./conversation-list";
import { useListResize } from "./use-list-resize";

/**
 * Live inbox (issue #13). Subscribes to Supabase Realtime `postgres_changes` on
 * the user's `messages` rows, so a simulated buyer question (INSERT), the agent's
 * draft (UPDATE) and the sent reply (INSERT + UPDATE) all appear WITHOUT refresh.
 *
 * Security: the browser client carries only the anon key + the user's session;
 * the subscription filter is user_id, and Realtime additionally authorizes every
 * event against the messages RLS select policy — another tenant's rows are never
 * streamed here.
 *
 * The simulate response is deliberately NOT merged into local state: the new
 * message must arrive via Realtime, which is exactly the acceptance criterion.
 * Two safeguards close the "INSERT lands before the listener is active" gap
 * (PR #35 review): simulation is disabled until the channel reports SUBSCRIBED,
 * and every time the subscription (re)reaches SUBSCRIBED the messages are
 * refetched and reconciled — Realtime stays the primary arrival path, the
 * refetch is the robustness backstop (e.g. rows written while reconnecting).
 */

export interface ItemOption {
  id: string;
  label: string;
}

interface InboxClientProps {
  userId: string;
  initialMessages: MessageRow[];
  items: ItemOption[];
  /** Deep-linked conversation (?c=<id>) resolved by the server page. */
  initialConversationId?: string | null;
}

function sortNewestFirst(messages: MessageRow[]): MessageRow[] {
  return [...messages].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Merge a freshly fetched snapshot with the current state. The snapshot wins by
 * default; a local row only survives when it is missing from the snapshot or
 * strictly newer (a Realtime event that landed after the snapshot was taken).
 */
function reconcileMessages(prev: MessageRow[], fetched: MessageRow[]): MessageRow[] {
  const byId = new Map(fetched.map((m) => [m.id, m] as const));
  for (const m of prev) {
    const snapshot = byId.get(m.id);
    if (!snapshot || snapshot.updated_at.localeCompare(m.updated_at) < 0) {
      byId.set(m.id, m);
    }
  }
  return sortNewestFirst([...byId.values()]);
}

export function InboxClient({
  userId,
  initialMessages,
  items,
  initialConversationId = null,
}: InboxClientProps) {
  // Clerk era (issue #41): the hook injects the Clerk session token per
  // request, so Realtime + reads stay RLS-scoped to the signed-in user.
  const supabase = useSupabaseClient();
  const [messages, setMessages] = useState<MessageRow[]>(() =>
    sortNewestFirst(initialMessages),
  );
  // Seller edits keyed by message id; absent → show the agent's draft as-is.
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Follow-up composer text keyed by conversation root (post-reply free text).
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});
  const [selectedItem, setSelectedItem] = useState<string>(items[0]?.id ?? "");
  // Which conversation (inbound message id) is open in the right pane / mobile
  // thread view. null → list view on mobile, calm placeholder on desktop.
  // Seeded from ?c= so a deep link (or refresh) restores the open thread.
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversationId,
  );
  const [busy, setBusy] = useState<string | null>(null); // "simulate" | "send:<id>" | "retry:<id>"
  const [error, setError] = useState<string | null>(null);
  // Honest connection state (audit): "connecting" | "live" | "failed" — the old
  // boolean could only ever say "Connecting…", even after the channel died.
  const [connection, setConnection] =
    useState<RealtimeConnectionState>("connecting");
  // Bumping this tears the channel down and re-subscribes (the quiet Retry).
  const [subscribeAttempt, setSubscribeAttempt] = useState(0);

  // Resizable conversation list (desktop) — width persists; drag tracks 1:1.
  // Dragging past the breakpoint snaps to an avatar-only rail (`collapsed`).
  const { width: listWidth, collapsed, dragging, handleProps } = useListResize();

  // Mobile is single-pane: opening a conversation slides the thread in over the
  // list, going Back slides it out. Desktop keeps both panes side by side, so
  // the thread renders in the static pane (no transform). One render fork, one
  // mounted ConversationThread.
  const isDesktop = useIsDesktopPane();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    let cancelled = false;

    // Refetch-on-SUBSCRIBED: anything inserted/updated before the listener was
    // active (or while the connection was down) is reconciled in here, so a
    // simulated question can never stay invisible until a page refresh.
    const refetch = async () => {
      const { data } = await supabase
        .from("messages")
        .select("*")
        .eq("user_id", userId);
      if (cancelled || !data) return;
      const rows = data
        .map((raw) => messageRowSchema.safeParse(raw))
        .filter((p) => p.success)
        .map((p) => p.data);
      setMessages((prev) => reconcileMessages(prev, rows));
    };

    const upsert = (raw: unknown) => {
      const parsed = messageRowSchema.safeParse(raw);
      if (!parsed.success) return;
      const row = parsed.data;
      setMessages((prev) =>
        sortNewestFirst([...prev.filter((m) => m.id !== row.id), row]),
      );
    };

    const channel = supabase
      .channel("inbox-messages")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => upsert(payload.new),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => upsert(payload.new),
      )
      .subscribe((status, err) => {
        if (cancelled) return;
        if (err || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("[realtime] inbox channel", status, err);
        }
        setConnection(connectionFromChannelStatus(status));
        if (status === "SUBSCRIBED") void refetch();
      });

    // Join watchdog: a channel that never reaches SUBSCRIBED (blocked
    // websocket, dead auth) would otherwise read "Connecting…" forever — past
    // the timeout it degrades to failed and the quiet Retry shows instead.
    const joinTimer = setTimeout(() => {
      if (!cancelled) setConnection((c) => connectionAfterJoinTimeout(c));
    }, REALTIME_JOIN_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearTimeout(joinTimer);
      supabase.removeChannel(channel);
    };
  }, [supabase, userId, subscribeAttempt]);

  // Tear down + re-subscribe the Realtime channel (the failed state's Retry).
  // The optimistic "connecting" reset lives here (an event handler), not in the
  // effect body — setState synchronously inside an effect cascades renders.
  const retryRealtime = () => {
    setConnection("connecting");
    setSubscribeAttempt((n) => n + 1);
  };

  // ── Open conversation ↔ browser history (audit) ──────────────────────────
  // On mobile, opening a conversation swaps the list for the thread; without a
  // history entry the browser/OS back button left the whole inbox. The open
  // conversation is encoded as ?c=<id> via the native history API (no server
  // round-trip): list → thread PUSHES (so Back returns to the list), switching
  // threads REPLACES (Back still closes in one step), and popstate restores
  // the selection from the URL. A pushed entry is marked in history.state so
  // the in-app Back button can pop it (keeping history clean) while a ?c=
  // deep link — where there's no list entry beneath us — just clears the
  // param in place instead of navigating off-site.
  function openConversation(id: string) {
    if (id === selectedId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("c", id);
    if (selectedId === null) {
      window.history.pushState(
        { ...window.history.state, inboxThread: true },
        "",
        url,
      );
    } else {
      window.history.replaceState(window.history.state, "", url);
    }
    setSelectedId(id);
  }

  function closeConversation() {
    if (selectedId === null) return;
    if (window.history.state?.inboxThread) {
      // We pushed this entry when opening — pop it; the popstate handler
      // clears the selection from the URL.
      window.history.back();
      return;
    }
    // Deep link: no list entry beneath us to pop back to.
    const url = new URL(window.location.href);
    url.searchParams.delete("c");
    window.history.replaceState(window.history.state, "", url);
    setSelectedId(null);
  }

  useEffect(() => {
    const onPopState = () => {
      setSelectedId(new URL(window.location.href).searchParams.get("c"));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Auto-dismiss the error toast so a transient send failure doesn't linger.
  // (It also clears on the next successful action.) Keyed on `error` so each new
  // message restarts the timer; cleanup cancels a stale timer on re-error/unmount.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  async function simulate() {
    if (!selectedItem) return;
    setBusy("simulate");
    setError(null);
    try {
      const res = await fetch("/api/inbox/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: selectedItem }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Simulation failed (${res.status})`);
      }
      // No local merge: the question + draft arrive over Realtime.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setBusy(null);
    }
  }

  async function approveAndSend(message: MessageRow) {
    const reply = (edits[message.id] ?? message.draft_reply ?? "").trim();
    if (reply === "") {
      setError("Reply cannot be empty.");
      return;
    }
    setBusy(`send:${message.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/inbox/${message.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Send failed (${res.status})`);
      }
      // Status flips + the outbound row arrive over Realtime.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(null);
    }
  }

  // Recovery for the claimed-but-undelivered state: the question is `sent` but
  // no outbound row exists (delivery failed / crashed after the CAS claim).
  // The endpoint is idempotent — a 409 means the reply was already delivered
  // (e.g. a concurrent retry won), so it is treated as success: the outbound
  // row arrives over Realtime either way.
  async function retryDelivery(message: MessageRow) {
    setBusy(`retry:${message.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/inbox/${message.id}/retry-delivery`, {
        method: "POST",
      });
      if (!res.ok && res.status !== 409) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Retry failed (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(null);
    }
  }

  // Recovery for a question whose DRAFT crashed after the insert (status
  // `draft_failed` — or stuck `new` after a serverless interrupt): re-run
  // drafting for the SAME row via the simulate endpoint's messageId form.
  // Idempotent — a 409 means a concurrent draft already attached.
  async function retryDraft(message: MessageRow) {
    if (!message.item_id) return;
    setBusy(`redraft:${message.id}`);
    setError(null);
    try {
      const res = await fetch("/api/inbox/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: message.item_id, messageId: message.id }),
      });
      if (!res.ok && res.status !== 409) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Draft retry failed (${res.status})`);
      }
      // The drafted row arrives over Realtime.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Draft retry failed");
    } finally {
      setBusy(null);
    }
  }

  // Send a follow-up message in a conversation already replied to. The outbound
  // row arrives over Realtime (same as a reply), so we only clear the composer.
  async function sendFollowUp(message: MessageRow) {
    const body = (followUpDrafts[message.id] ?? "").trim();
    if (body === "") return;
    setBusy(`followup:${message.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/inbox/${message.id}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: body }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? `Send failed (${res.status})`);
      }
      setFollowUpDrafts((prev) => ({ ...prev, [message.id]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(null);
    }
  }

  const inbound = useMemo(
    () => messages.filter((m) => m.direction === "inbound"),
    [messages],
  );
  // The CANONICAL reply per question (the one the CAS claim/undelivered logic
  // tracks). Follow-ups also carry reply_to but are excluded here — otherwise a
  // later follow-up would overwrite the canonical reply and break undelivered
  // detection.
  const repliesByQuestion = useMemo(() => {
    const map = new Map<string, MessageRow>();
    for (const m of messages) {
      if (
        m.direction === "outbound" &&
        m.reply_to &&
        m.reply_kind !== "followup"
      ) {
        map.set(m.reply_to, m);
      }
    }
    return map;
  }, [messages]);

  // Follow-up messages (post-reply) grouped by conversation root, oldest→newest
  // so the thread appends them after the canonical reply in send order.
  const followUpsByQuestion = useMemo(() => {
    const map = new Map<string, MessageRow[]>();
    for (const m of messages) {
      if (m.direction === "outbound" && m.reply_to && m.reply_kind === "followup") {
        const list = map.get(m.reply_to) ?? [];
        list.push(m);
        map.set(m.reply_to, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return map;
  }, [messages]);

  // item_id → display label, so a conversation row can name the listing.
  const itemLabels = useMemo(
    () => new Map(items.map((i) => [i.id, i.label] as const)),
    [items],
  );

  // Resolve the open conversation; if it scrolled out of the snapshot (e.g.
  // reconciled away) the placeholder shows again rather than a dangling pane.
  const selectedMessage = selectedId
    ? inbound.find((m) => m.id === selectedId) ?? null
    : null;
  const buyerLabelFor = (m: MessageRow) =>
    (m.item_id ? itemLabels.get(m.item_id) : undefined) ?? "Buyer question";

  const unreadCount = inbound.reduce((n, m) => {
    const replied = m.status === "sent" && repliesByQuestion.has(m.id);
    return replied ? n : n + 1;
  }, 0);

  // Zero conversations → keep the rich empty state (with the simulator above
  // it), padded into a centered column since the surface is now full-bleed.
  if (inbound.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6">
        <SimulatorCard
          items={items}
          selectedItem={selectedItem}
          onSelectItem={setSelectedItem}
          onSimulate={simulate}
          connection={connection}
          onRetryConnection={retryRealtime}
          simulating={busy === "simulate"}
        />
        <InboxEmptyState />
        <ErrorToast error={error} reduceMotion={!!reduceMotion} onDismiss={() => setError(null)} />
      </div>
    );
  }

  // One thread instance, reused by whichever layout is live (desktop static
  // pane OR mobile slide-over) — the `isDesktop` fork below guarantees only one
  // is mounted at a time, so the composer's `reply-<id>` input id stays unique.
  const conversationThread = selectedMessage ? (
    <ConversationThread
      state={deriveConversationState(selectedMessage, repliesByQuestion, busy)}
      buyerName={buyerLabelFor(selectedMessage)}
      edits={edits}
      busy={busy}
      followUps={followUpsByQuestion.get(selectedMessage.id) ?? []}
      followUpValue={followUpDrafts[selectedMessage.id] ?? ""}
      onEdit={(id, value) => setEdits((prev) => ({ ...prev, [id]: value }))}
      onApproveAndSend={approveAndSend}
      onRetryDelivery={retryDelivery}
      onRetryDraft={retryDraft}
      onFollowUpChange={(id, value) =>
        setFollowUpDrafts((prev) => ({ ...prev, [id]: value }))
      }
      onSendFollowUp={sendFollowUp}
      onBack={closeConversation}
    />
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Error is a FLOATING toast (not an in-flow banner): the old banner sat
          above the two-pane shell and pushed both panes down when it appeared,
          reshifting the whole layout. Fixed-position + fade keeps the panes
          perfectly still. */}
      <ErrorToast error={error} reduceMotion={!!reduceMotion} onDismiss={() => setError(null)} />

      {/* Two-pane messaging shell — fills the surface edge-to-edge (no card
          border/radius): the list and thread each scroll independently. The
          parent `main` owns the bounded desktop height, so the panes fill it
          via flex-1 and scroll internally; mobile shows one pane at a time
          (list by default, thread once selected; back button returns). The
          whole surface eases in on mount (no abrupt pop), and the list width is
          published as --inbox-list-w for the resizable divider below. */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        style={{ "--inbox-list-w": `${listWidth}px` } as React.CSSProperties}
        className={`relative flex min-h-[60vh] flex-1 overflow-hidden bg-surface lg:min-h-0 ${
          dragging ? "select-none" : ""
        }`}
      >
        {/* ── left: conversation list (resizable on desktop) ── */}
        <nav
          aria-label="Buyer conversations"
          className={`flex min-h-0 w-full flex-col border-border lg:w-[var(--inbox-list-w)] lg:shrink-0 ${
            dragging ? "" : "lg:transition-[width] lg:duration-200 lg:ease-out"
          }`}
        >
          {/* full header — mobile always; desktop when expanded */}
          <header
            className={`flex h-[72px] items-center justify-between gap-2 bg-surface-2 px-4 ${
              collapsed ? "lg:hidden" : ""
            }`}
          >
            <span className="flex items-baseline gap-2">
              <h2 className="text-[14px] font-semibold text-fg-strong">
                Conversations
              </h2>
              {unreadCount > 0 ? (
                <span
                  data-nums
                  className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-soft-fg"
                >
                  {unreadCount} new
                </span>
              ) : null}
            </span>
            <SimulatorMenu
              items={items}
              selectedItem={selectedItem}
              onSelectItem={setSelectedItem}
              onSimulate={simulate}
              connection={connection}
              onRetryConnection={retryRealtime}
              simulating={busy === "simulate"}
            />
          </header>
          {/* collapsed header — desktop rail only: just the simulate trigger */}
          <div
            className={`hidden h-[72px] items-center justify-center bg-surface-2 ${
              collapsed ? "lg:flex" : ""
            }`}
          >
            <SimulatorMenu
              compact
              items={items}
              selectedItem={selectedItem}
              onSelectItem={setSelectedItem}
              onSimulate={simulate}
              connection={connection}
              onRetryConnection={retryRealtime}
              simulating={busy === "simulate"}
            />
          </div>
          {/* Quiet failed-connection strip (audit): the simulator (which carries
              the live dot) is folded into a popover here, so a dead channel
              needs its own honest, small affordance — muted text + Retry, no
              red banner; green stays reserved for Live. */}
          {connection === "failed" ? (
            <div
              className={`flex items-center justify-between gap-2 bg-surface-2/60 px-4 py-1.5 ${
                collapsed ? "lg:hidden" : ""
              }`}
            >
              <span className="truncate text-[12px] text-faint">
                Live updates unavailable
              </span>
              <button
                type="button"
                onClick={retryRealtime}
                className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[12px] font-semibold text-fg transition-colors hover:bg-surface-2"
              >
                Retry
              </button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* full list — mobile always; desktop when expanded */}
            <div className={collapsed ? "lg:hidden" : ""}>
              <ConversationList
                inbound={inbound}
                repliesByQuestion={repliesByQuestion}
                busy={busy}
                itemLabels={itemLabels}
                selectedId={selectedId}
                onSelect={openConversation}
              />
            </div>
            {/* collapsed avatar rail — desktop only */}
            {collapsed ? (
              <div className="hidden lg:block">
                <ConversationRail
                  inbound={inbound}
                  repliesByQuestion={repliesByQuestion}
                  busy={busy}
                  itemLabels={itemLabels}
                  selectedId={selectedId}
                  onSelect={openConversation}
                />
              </div>
            ) : null}
          </div>
        </nav>

        {/* ── drag handle: resize the conversation list (desktop only). A thin
            divider that thickens to the accent on hover/drag. Pointer capture
            keeps the drag alive past the 4px hit area. ── */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation list"
          {...handleProps}
          className="group relative hidden w-1.5 shrink-0 cursor-col-resize touch-none lg:block"
        >
          <span
            aria-hidden
            className={`absolute inset-y-0 left-1/2 -translate-x-1/2 transition-all ${
              dragging
                ? "w-[2px] bg-accent"
                : "w-px bg-border group-hover:w-[2px] group-hover:bg-accent/60"
            }`}
          />
        </div>

        {/* ── right: selected thread / placeholder (desktop static pane) ── */}
        <section
          aria-label="Conversation"
          className="hidden min-h-0 flex-1 flex-col lg:flex"
        >
          {isDesktop ? conversationThread ?? <ThreadPlaceholder /> : null}
        </section>

        {/* ── mobile slide-over: the thread pushes in from the right over the
            list, and slides back out on Back — entering AND exiting animate.
            Mounted only below `lg` (single-pane), so it never double-renders the
            thread that the desktop pane already holds. ── */}
        <AnimatePresence initial={false}>
          {!isDesktop && selectedMessage ? (
            <motion.section
              key="mobile-thread"
              aria-label="Conversation"
              className="absolute inset-0 z-20 flex min-h-0 flex-col bg-surface lg:hidden"
              initial={reduceMotion ? { opacity: 0 } : { x: "100%" }}
              animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
              transition={
                reduceMotion
                  ? { duration: 0.15 }
                  : { type: "tween", duration: 0.28, ease: [0.22, 1, 0.36, 1] }
              }
            >
              {conversationThread}
            </motion.section>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/**
 * Floating error toast — danger-styled sibling of the dashboard's confirmation
 * toast (same fixed/bottom/sidebar-offset + fade choreography), so action
 * failures ("Failed to send follow-up") never reflow the messaging panes. Fades
 * in/out via AnimatePresence (keyed on the message), auto-dismisses on a timer
 * in the client, and is tap-dismissible. Reduced-motion → pure opacity crossfade.
 */
function ErrorToast({
  error,
  reduceMotion,
  onDismiss,
}: {
  error: string | null;
  reduceMotion: boolean;
  onDismiss: () => void;
}) {
  return (
    <AnimatePresence>
      {error ? (
        <motion.div
          key={error}
          initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 sm:bottom-8 sm:left-[var(--sidebar-w)]"
        >
          <div
            role="alert"
            className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-full border border-danger-border bg-danger-soft px-4 py-2.5 text-[13px] font-medium text-danger-soft-fg shadow-lg"
          >
            <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4m0 4h.01" />
            </svg>
            <span className="min-w-0">{error}</span>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-danger-soft-fg/70 transition-colors hover:bg-danger-border/40 hover:text-danger-soft-fg"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Simulator trigger in the list-pane header. The bench (SimulatorCard) opens in
 * a portaled, centered overlay — NOT an absolutely-positioned popover, which the
 * two-pane shell's `overflow-hidden` clipped (and which overflowed the narrow,
 * resizable list pane). Portaling to <body> escapes that clip and centers
 * cleanly on every viewport, mobile included. `compact` renders an icon-only
 * trigger for the collapsed avatar rail.
 */
export function SimulatorMenu(props: {
  items: ItemOption[];
  selectedItem: string;
  onSelectItem: (id: string) => void;
  onSimulate: () => void;
  connection: RealtimeConnectionState;
  onRetryConnection?: () => void;
  simulating: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const FlaskIcon = (
    <svg viewBox="0 0 24 24" className="size-3.5 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 2v6.3L4.6 17.4A2 2 0 0 0 6.3 20.5h11.4a2 2 0 0 0 1.7-3.1L14 8.3V2" />
      <path d="M8.5 2h7" />
    </svg>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Simulate a buyer question"
        className={
          props.compact
            ? "flex size-9 items-center justify-center rounded-lg border border-border text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            : "flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        }
      >
        {FlaskIcon}
        {props.compact ? null : "Simulate"}
      </button>
      {open
        ? createPortal(
            <div
              // Backdrop spans the viewport; the card centers over the CONTENT
              // area (left pad = sidebar width on sm+) so it doesn't sit
              // right-of-center past the side panel. Mobile has no sidebar.
              className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(26,26,26,0.32)] p-4 backdrop-blur-[2px] sm:pl-[calc(var(--sidebar-w)+1rem)]"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) setOpen(false);
              }}
            >
              <div className="palette-pop mt-[12vh] w-full max-w-sm">
                <SimulatorCard
                  items={props.items}
                  selectedItem={props.selectedItem}
                  onSelectItem={props.onSelectItem}
                  onSimulate={() => {
                    props.onSimulate();
                    setOpen(false);
                  }}
                  connection={props.connection}
                  onRetryConnection={props.onRetryConnection}
                  simulating={props.simulating}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
