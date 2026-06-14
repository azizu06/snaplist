import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import {
  loadOrGenerateExportPacks,
  type ExportPackView,
} from "@/lib/export";
import { logEvent } from "@/lib/observability";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyButton } from "./copy-button";

/**
 * Export page (issue #15; #40 skin) — Facebook Marketplace + Mercari copy-paste
 * packs for one item. Per-channel cards with copy feedback (E-1) plus the
 * numbered how-to-post steps a first-time casual seller actually needs (E-2):
 * these platforms have no listing APIs, so the pack is pasted by hand and the
 * photos are re-attached from the phone — say so plainly.
 *
 * Data path unchanged: RLS-scoped reads, the load-or-generate seam, the latest
 * logged price rendered verbatim.
 */
export default async function ExportPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=/export/${itemId}`);

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
      userId: userId,
      itemId,
      attributes,
      price,
    });
  } catch (err) {
    // Server component renders this string to the client — keep the raw Supabase/
    // generation error server-side and show a generic message (CWE-209, #57).
    logEvent("export.generate", {
      ok: false,
      itemId,
      error: err instanceof Error ? err.message : String(err),
    });
    error = "We couldn't generate the export packs. Please try again.";
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex items-center gap-3">
        <Link
          href={`/review/${itemId}`}
          aria-label="Back to review"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:text-fg"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Cross-post your listing
        </h1>
      </header>

      <p className="text-[14px] leading-relaxed text-muted">
        Facebook Marketplace and Mercari don&apos;t allow apps to post for you,
        so SnapList prepares a ready-to-paste pack for each, written in that
        platform&apos;s style, using only your verified item details
        {price != null ? " and your stored price" : ""}.
      </p>

      {error ? (
        <Banner variant="error" title="Couldn’t prepare the export packs">
          {error}. Reload the page to try again.
        </Banner>
      ) : packs ? (
        <>
          <PackCard
            heading="Facebook Marketplace"
            note="Casual and short, framed for local pickup."
            steps={[
              "Copy the pack below.",
              "In the Facebook app: Marketplace → Sell → Item.",
              "Add your photos from your camera roll (photos can't ride the clipboard).",
              "Paste (first line is the title, the rest is the description) and set the price.",
            ]}
            pack={packs.facebook}
          />
          <PackCard
            heading="Mercari"
            note="Short title, shipping-oriented description, hashtags."
            steps={[
              "Copy the pack below.",
              "In the Mercari app: Sell → take or add your photos.",
              "Paste the title and description, then set the price and shipping.",
            ]}
            pack={packs.mercari}
          />
          {packs.model ? (
            <p className="text-[13.5px] text-faint">
              Logged for evaluation · model: {packs.model}
            </p>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

function PackCard({
  heading,
  note,
  steps,
  pack,
}: {
  heading: string;
  note: string;
  steps: string[];
  pack: ExportPackView;
}) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold text-accent-soft-fg">
            {heading}
          </span>
        }
        aside={<CopyButton text={pack.copyBlock} label={`Copy the ${heading} pack`} />}
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-[13.5px] text-muted">{note}</p>
        <pre className="whitespace-pre-wrap rounded-lg border border-border bg-surface-2/60 p-4 font-sans text-[15px] leading-relaxed text-fg">
          {pack.copyBlock}
        </pre>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13.5px] text-muted">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
