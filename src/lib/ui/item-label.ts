function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read only the three name fields, one by one, so a malformed unrelated attribute
 * (specs, measurements) cannot hide a usable name (#1117).
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
 * shows two different names. A seller-facing caller passes `untitled` so an
 * item still being identified reads as a neutral placeholder, never an id.
 */
export function itemLabel(
  attributes: unknown,
  id: string,
  listingTitle?: string | null,
  untitled?: string,
): string {
  const a = readNameFields(attributes);
  const label = [a.brand, a.model].filter(Boolean).join(" ") || a.title;
  if (label) return label;
  const draftTitle = listingTitle?.trim();
  if (draftTitle) return draftTitle;
  return untitled ?? `Item ${id.slice(0, 8)}`;
}
