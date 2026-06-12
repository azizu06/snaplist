import { extractedAttributesSchema } from "@/lib/pipeline/types";

/**
 * Human label for an item from its extracted attributes — "brand model"
 * first, the vision title second, a truncated id as the last resort. Shared
 * by the dashboard row assembly and the ⌘K search API so the same item never
 * shows two different names.
 */
export function itemLabel(attributes: unknown, id: string): string {
  const parsed = extractedAttributesSchema.safeParse(attributes ?? {});
  if (parsed.success) {
    const a = parsed.data;
    const label = [a.brand, a.model].filter(Boolean).join(" ") || a.title;
    if (label) return label;
  }
  return `Item ${id.slice(0, 8)}`;
}
