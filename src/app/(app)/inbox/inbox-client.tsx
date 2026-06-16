"use client";

import { useEffect, useState } from "react";
import { useSupabaseClient } from "@/lib/supabase/client";
import { messageRowSchema, type MessageRow } from "@/lib/inbox";
import { InboxEmptyState } from "./inbox-empty";
import { SimulatorCard } from "./simulator-card";
import { ConversationList } from "./conversation-list";

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
  // Clerk era (issue #41): the hook injects the Clerk session token per
  // request, so Realtime + reads stay RLS-scoped to the signed-in user.
  const supabase = useSupabaseClient();
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
      <SimulatorCard
        items={items}
        selectedItem={selectedItem}
        onSelectItem={setSelectedItem}
        onSimulate={simulate}
        live={live}
        simulating={busy === "simulate"}
      />

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-soft px-4 py-3 text-[15px] text-danger-soft-fg"
        >
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-fg-strong">Conversations</h2>
          {inbound.length > 0 ? (
            <span
              data-nums
              className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted"
            >
              {inbound.length}
            </span>
          ) : null}
        </div>
        {inbound.length === 0 ? (
          <InboxEmptyState />
        ) : (
          <ConversationList
            inbound={inbound}
            repliesByQuestion={repliesByQuestion}
            edits={edits}
            busy={busy}
            onEdit={(id, value) =>
              setEdits((prev) => ({ ...prev, [id]: value }))
            }
            onApproveAndSend={approveAndSend}
            onRetryDelivery={retryDelivery}
            onRetryDraft={retryDraft}
          />
        )}
      </section>
    </div>
  );
}
