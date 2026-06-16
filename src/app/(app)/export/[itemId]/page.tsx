import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import { loadOrGenerateExportPacks } from "@/lib/export";
import { reportServerError } from "@/lib/sentry";
import { ExportView } from "./export-view";

/**
 * Export page (issue #15; #40 skin; ui-lifecycle-revamp) — Facebook Marketplace
 * + Mercari copy-paste packs for one item. The render now lives in the
 * presentational `ExportView` (preview-harness friendly, like review/publish);
 * this page stays the RLS-scoped data path: load the item + a thumbnail, the
 * latest logged price, and the load-or-generate export packs.
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
    .select("id, attributes, condition, photos")
    .eq("id", itemId)
    .single();
  if (!item) notFound();

  // The validated attribute core — the ONLY source of facts for the packs.
  const parsedAttrs = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const attributes = parsedAttrs.success ? parsedAttrs.data : {};
  if (item.condition && !attributes.condition) {
    attributes.condition = item.condition as string;
  }

  // A composed product name + a thumbnail so the seller can see WHAT they're
  // cross-posting. Same short-lived signed-URL pattern as the review page.
  const itemName =
    [attributes.brand, attributes.model].filter(Boolean).join(" ") ||
    attributes.category ||
    "Your item";

  let itemThumb: string | null = null;
  const photoPaths = (item.photos as string[] | null) ?? [];
  if (photoPaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("photos")
      .createSignedUrl(photoPaths[0], 60 * 10);
    itemThumb = signed?.signedUrl ?? null;
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
      : null;

  let packs;
  let error: string | null = null;
  try {
    packs = await loadOrGenerateExportPacks(supabase, {
      userId: userId,
      itemId,
      attributes,
      price: price ?? undefined,
    });
  } catch (err) {
    // Keep the raw Supabase/generation error server-side and show a generic
    // message (CWE-209, #57).
    reportServerError("export.generate", err, { itemId });
    error = "We couldn't generate the export packs. Please try again.";
  }

  return (
    <ExportView
      data={{
        itemId,
        itemName,
        itemThumb,
        condition: attributes.condition ?? null,
        price,
        packs: packs ?? null,
        error,
      }}
    />
  );
}
