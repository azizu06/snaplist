"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { messageRowSchema, type MessageRow } from "@/lib/inbox";

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

export function InboxClient({ userId, initialMessages, items }: InboxClientProps) {
  const supabase = useMemo(() => createClient(), []);
  const [messages, setMessages] = useState<MessageRow[]>(() =>
    sortNewestFirst(initialMessages),
  );
  // Seller edits keyed by message id; absent → show the agent's draft as-is.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selectedItem, setSelectedItem] = useState<string>(items[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null); // "simulate" | "send:<id>" | "retry:<id>"
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

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
      .subscribe((status) => {
        const subscribed = status === "SUBSCRIBED";
        setLive(subscribed);
        if (subscribed) void refetch();
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [supabase, userId]);

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

  const inbound = messages.filter((m) => m.direction === "inbound");
  const repliesByQuestion = new Map<string, MessageRow>();
  for (const m of messages) {
    if (m.direction === "outbound" && m.reply_to) {
      repliesByQuestion.set(m.reply_to, m);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-xs sm:p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg-strong">
            Simulate a buyer question
          </h2>
          <span
            className={
              live
                ? "inline-flex items-center gap-1.5 rounded-full border border-success-border bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-soft-fg"
                : "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-muted"
            }
          >
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${live ? "bg-success" : "bg-faint"}`}
            />
            {live ? "Live" : "Connecting…"}
          </span>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            No items yet — create a listing first, then simulate a buyer question
            about it.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedItem}
              onChange={(e) => setSelectedItem(e.target.value)}
              className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg"
              aria-label="Item to ask about"
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={simulate}
              // Disabled until the Realtime subscription is live: simulating
              // before SUBSCRIBED could let the INSERT land before the listener
              // is active, leaving the question invisible until refresh.
              disabled={busy === "simulate" || !live}
              title={live ? undefined : "Waiting for the live connection…"}
              className="rounded-md bg-accent-solid px-4 py-2 text-sm font-medium text-accent-fg shadow-xs transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-60"
            >
              {busy === "simulate"
                ? "Asking…"
                : live
                  ? "Simulate buyer question"
                  : "Connecting…"}
            </button>
          </div>
        )}
        <p className="text-xs text-faint">
          Sandbox: replies are drafted by the agent, approved by you, and delivery
          is a logged no-op until the eBay adapter lands.
        </p>
      </section>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg"
        >
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-fg-strong">Messages</h2>
        {inbound.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
            <p className="text-base font-semibold text-fg-strong">
              No buyer questions yet
            </p>
            <p className="max-w-sm text-sm text-muted">
              The moment one arrives we&apos;ll draft a reply for your approval —
              it will appear here without a refresh. Try the simulator above.
            </p>
          </div>
        ) : (
          inbound.map((message) => {
            const sentReply = repliesByQuestion.get(message.id);
            const draftValue = edits[message.id] ?? message.draft_reply ?? "";
            // Claimed-but-undelivered (PR #35 review): the inbound row is
            // `sent` but no outbound row references it — delivery failed (or
            // the process crashed) after the CAS claim, before the outbound
            // insert. While OUR send request is in flight (busy) the two
            // Realtime events (UPDATE then INSERT) may arrive split, so that
            // window renders as "sending", not as a delivery failure.
            const sending =
              message.status === "sent" &&
              !sentReply &&
              busy === `send:${message.id}`;
            const undelivered =
              message.status === "sent" && !sentReply && !sending;
            return (
              <article
                key={message.id}
                className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-xs sm:p-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-muted">Buyer asked</span>
                  <span
                    className={
                      undelivered || message.status === "draft_failed"
                        ? "rounded-full border border-danger-border bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger-soft-fg"
                        : message.status === "sent"
                          ? "rounded-full border border-success-border bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-soft-fg"
                          : message.status === "drafted"
                            ? "rounded-full border border-warning-border bg-warning-soft px-2.5 py-0.5 text-xs font-medium text-warning-soft-fg"
                            : "rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-muted"
                    }
                  >
                    {undelivered
                      ? "Not delivered"
                      : message.status === "sent"
                        ? sending
                          ? "Sending…"
                          : "Replied"
                        : message.status === "drafted"
                          ? "Draft ready"
                          : message.status === "draft_failed"
                            ? "Draft failed"
                            : "Drafting…"}
                  </span>
                </div>
                <p className="text-sm text-fg">{message.body}</p>

                {undelivered ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft p-3">
                    <p className="text-xs font-semibold text-danger-soft-fg">
                      Reply not delivered — delivery failed after your approval
                    </p>
                    {message.draft_reply ? (
                      <p className="whitespace-pre-wrap text-sm text-fg">
                        {message.draft_reply}
                      </p>
                    ) : null}
                    <div>
                      <button
                        type="button"
                        onClick={() => retryDelivery(message)}
                        disabled={busy === `retry:${message.id}`}
                        className="rounded-md bg-danger-solid px-4 py-2 text-sm font-medium text-white shadow-xs transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
                      >
                        {busy === `retry:${message.id}` ? "Retrying…" : "Retry delivery"}
                      </button>
                    </div>
                  </div>
                ) : message.status === "draft_failed" ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft p-3">
                    <p className="text-xs font-semibold text-danger-soft-fg">
                      Draft failed — we couldn&apos;t write a reply for this one
                    </p>
                    <div>
                      <button
                        type="button"
                        onClick={() => retryDraft(message)}
                        disabled={busy === `redraft:${message.id}`}
                        className="rounded-md bg-danger-solid px-4 py-2 text-sm font-medium text-white shadow-xs transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
                      >
                        {busy === `redraft:${message.id}` ? "Retrying…" : "Retry draft"}
                      </button>
                    </div>
                  </div>
                ) : message.status === "sent" ? (
                  <div className="rounded-lg bg-surface-2 p-3">
                    <p className="text-xs font-medium text-faint">
                      Your reply{sentReply?.sent_at ? " · sent (stubbed delivery)" : ""}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-fg">
                      {sentReply?.body ?? message.draft_reply}
                    </p>
                  </div>
                ) : message.status === "drafted" ? (
                  <div className="flex flex-col gap-2">
                    <label
                      htmlFor={`reply-${message.id}`}
                      className="text-xs font-medium text-faint"
                    >
                      AI draft from your listing — edit before sending
                      {message.draft_model ? ` · ${message.draft_model}` : ""}
                    </label>
                    <textarea
                      id={`reply-${message.id}`}
                      value={draftValue}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [message.id]: e.target.value }))
                      }
                      rows={3}
                      className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg"
                    />
                    <div>
                      <button
                        type="button"
                        onClick={() => approveAndSend(message)}
                        disabled={busy === `send:${message.id}`}
                        className="rounded-md bg-accent-solid px-4 py-2 text-sm font-medium text-accent-fg shadow-xs transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-60"
                      >
                        {busy === `send:${message.id}` ? "Sending…" : "Approve & send"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-faint">
                    Drafting a reply from your listing…
                  </p>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
