import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { messageRowSchema, type MessageRow } from "@/lib/inbox";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import { InboxClient, type ItemOption } from "./inbox-client";

/**
 * Buyer inbox (issue #13) — server shell. Loads the initial snapshot (messages +
 * the user's items for the simulate picker) through the USER-SCOPED server client
 * (RLS-scoped: only the caller's rows), then hands off to the client component,
 * which keeps the list LIVE via a Supabase Realtime subscription — a simulated
 * buyer question appears with no refresh.
 */
export default async function InboxPage() {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/inbox");

  const [{ data: messages }, { data: items }] = await Promise.all([
    supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("items")
      .select("id, attributes, condition, created_at")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const initialMessages: MessageRow[] = (messages ?? []).flatMap((row) => {
    const parsed = messageRowSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });

  const itemOptions: ItemOption[] = (items ?? []).map((item) => {
    const attrs = extractedAttributesSchema.safeParse(item.attributes ?? {});
    const a = attrs.success ? attrs.data : {};
    const label =
      [a.brand, a.model].filter(Boolean).join(" ") ||
      a.title ||
      `Item ${String(item.id).slice(0, 8)}`;
    return { id: item.id as string, label };
  });

  return (
    // The whole content area IS the message center (owner): no title strip, no
    // page padding. The two-pane fills it top to bottom; the calm middle state
    // (no conversation selected) carries the "what this is / how it works" copy.
    // Explicit viewport height on every size (the AppShell's min-h-full doesn't
    // resolve on mobile — body is min-h-screen, not a definite height — so a
    // flex-1 child can't fill and the list left a dead gap below it). Mobile
    // subtracts the 72px top bar AND the 80px floating-dock clearance (pb-20);
    // desktop has no dock, so it only subtracts the top bar. Both clip and let
    // the two panes scroll internally.
    <main className="flex h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] w-full flex-col overflow-hidden lg:h-[calc(100dvh-72px)]">
      <InboxClient
        userId={userId}
        initialMessages={initialMessages}
        items={itemOptions}
      />
    </main>
  );
}
