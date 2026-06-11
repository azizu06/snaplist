import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import {
  loadOrGenerateExportPacks,
  type ExportPackView,
} from "@/lib/export";
import { CopyButton } from "./copy-button";

/**
 * Export page (issue #15) — Facebook Marketplace + Mercari copy-paste packs for
 * one item, each rendered as a single clean block with a copy button.
 *
 * Reads the item through the USER-SCOPED server client (RLS proves ownership;
 * another user's id 404s), takes the price the item record carries today (the
 * latest prediction log's recommendation — rendered verbatim, never invented),
 * and serves the packs through the load-or-generate seam: generated once,
 * persisted as 'facebook' / 'mercari' listings rows, then reused.
 */
export default async function ExportPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/export/${itemId}`);

  // RLS scopes this to the owner. A non-owner / missing id returns no row → 404.
  const { data: item } = await supabase
    .from("items")
    .select("id, attributes, condition")
    .eq("id", itemId)
    .single();
  if (!item) notFound();

  // The validated attribute core — the ONLY source of facts for the packs.
  const parsedAttrs = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const attributes = parsedAttrs.success ? parsedAttrs.data : {};
  if (item.condition && !attributes.condition) {
    attributes.condition = item.condition as string;
  }

  // The price the item record carries today: the latest logged recommendation.
  const { data: log } = await supabase
    .from("prediction_logs")
    .select("price")
    .eq("item_id", itemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const price =
    log?.price != null && Number.isFinite(Number(log.price))
      ? Number(log.price)
      : undefined;

  let packs;
  let error: string | null = null;
  try {
    packs = await loadOrGenerateExportPacks(supabase, {
      userId: user.id,
      itemId,
      attributes,
      price,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : "Export pack generation failed.";
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Export packs</h1>
        <Link
          href={`/review/${itemId}`}
          className="text-sm text-zinc-500 underline hover:text-zinc-800"
        >
          Back to review
        </Link>
      </header>

      <p className="text-sm text-zinc-500">
        Copy-paste blocks for cross-posting. Each block follows its platform’s
        conventions and uses only the verified item details
        {price != null ? " and your stored price" : ""}.
      </p>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Couldn’t prepare the export packs: {error}
        </p>
      ) : packs ? (
        <>
          <PackSection
            heading="Facebook Marketplace"
            note="Casual and short, framed for local pickup."
            pack={packs.facebook}
          />
          <PackSection
            heading="Mercari"
            note="Short title, shipping-oriented description, hashtags."
            pack={packs.mercari}
          />
          {packs.model ? (
            <p className="text-xs text-zinc-400">
              Logged for evaluation · model: {packs.model}
            </p>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

function PackSection({
  heading,
  note,
  pack,
}: {
  heading: string;
  note: string;
  pack: ExportPackView;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
            {heading}
          </h2>
          <p className="text-xs text-zinc-400">{note}</p>
        </div>
        <CopyButton text={pack.copyBlock} label={`Copy the ${heading} pack`} />
      </div>
      <pre className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-4 font-sans text-sm text-zinc-800">
        {pack.copyBlock}
      </pre>
    </section>
  );
}
