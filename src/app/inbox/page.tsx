import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/inbox");

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
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
          Buyer inbox
        </h1>
        <p className="mt-1 text-sm text-muted">
          Questions from buyers appear here live. We draft a reply from the
          listing — you approve or edit before anything sends.
        </p>
      </header>

      <InboxClient
        userId={user.id}
        initialMessages={initialMessages}
        items={itemOptions}
      />
    </main>
  );
}
