import { extractedAttributesSchema } from "@/lib/pipeline/types";

/**
 * Human label for an item from its extracted attributes — "brand model"
 * first, the vision title second, the generated listing (draft) title third,
 * a truncated id as the last resort. Shared
 * by the dashboard row assembly and the ⌘K search API so the same item never
 * shows two different names.
 */
export function itemLabel(
  attributes: unknown,
  id: string,
  listingTitle?: string | null,
): string {
  const parsed = extractedAttributesSchema.safeParse(attributes ?? {});
  if (parsed.success) {
    const a = parsed.data;
    const label =
      [a.brand?.trim(), a.model?.trim()].filter(Boolean).join(" ") || a.title?.trim();
    if (label) return label;
  }
  const draftTitle = listingTitle?.trim();
  if (draftTitle) return draftTitle;
  return `Item ${id.slice(0, 8)}`;
}
