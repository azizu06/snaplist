function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read only the three name fields, one by one. A whole-object schema parse would throw
 * away a usable title when an unrelated attribute (specs, measurements) is malformed,
 * and the seller would see "Item <id>" for a finished item (#1117).
 */
function readNameFields(attributes: unknown): {
  brand: string;
  model: string;
  title: string;
} {
  const source =
    attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
  return {
    brand: trimmedString(source.brand),
    model: trimmedString(source.model),
    title: trimmedString(source.title),
  };
}

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
  const a = readNameFields(attributes);
  const label = [a.brand, a.model].filter(Boolean).join(" ") || a.title;
  if (label) return label;
  const draftTitle = listingTitle?.trim();
  if (draftTitle) return draftTitle;
  return `Item ${id.slice(0, 8)}`;
}
