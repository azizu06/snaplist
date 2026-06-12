import { parsePriceOverride } from "./autopilot";

/**
 * Review-screen edits (UI pass: "why is it all on auto?"). The review form
 * submits every AI-filled field as a REAL input — title, description,
 * category, condition, price — and this helper normalizes/validates the
 * untrusted FormData values at the write boundary, so the server action stays
 * a thin RLS-scoped persistence shell.
 *
 * Pure and synchronous so it can be unit-tested directly (the repo's
 * "test the seam" rule): junk throws loudly, blanks mean "clear", and the
 * price reuses the battle-tested parsePriceOverride.
 */

/** eBay's hard title ceiling — the generator targets it, the editor enforces it. */
export const EBAY_TITLE_MAX = 80;

export interface ReviewEdits {
  /** Listing copy updates; null when the form had no listing to edit. */
  listing: { title: string; description: string } | null;
  /** Trimmed category, or null to clear it from the attributes. */
  category: string | null;
  /** Trimmed condition, or null to clear it. */
  condition: string | null;
  /** Price override in dollars (cent-normalized), or null to fall back to the suggestion. */
  override: number | null;
}

export interface RawReviewEdits {
  /** Whether the item has a listing row (title/description are editable). */
  hasListing: boolean;
  title: unknown;
  description: unknown;
  category: unknown;
  condition: unknown;
  price: unknown;
}

function asTrimmedString(value: unknown, field: string): string {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected text.`);
  }
  return value.trim();
}

/**
 * Normalize + validate the review form's edits. Throws (with a message safe to
 * surface) on values that are present but unusable — a typo must never be
 * silently coerced into clearing a seller's data.
 */
export function parseReviewEdits(raw: RawReviewEdits): ReviewEdits {
  const category = asTrimmedString(raw.category, "category");
  const condition = asTrimmedString(raw.condition, "condition");

  let listing: ReviewEdits["listing"] = null;
  if (raw.hasListing) {
    const title = asTrimmedString(raw.title, "title");
    const description = asTrimmedString(raw.description, "description");
    if (title === "") {
      throw new Error("Title can’t be empty — buyers search on it.");
    }
    if (title.length > EBAY_TITLE_MAX) {
      throw new Error(
        `Title is ${title.length} characters — eBay allows at most ${EBAY_TITLE_MAX}.`,
      );
    }
    if (description === "") {
      throw new Error("Description can’t be empty.");
    }
    listing = { title, description };
  }

  // parsePriceOverride throws on junk and returns null for blank ("use the
  // AI suggestion again") — exactly the semantics the price field needs.
  const override = parsePriceOverride(raw.price);

  return {
    listing,
    category: category === "" ? null : category,
    condition: condition === "" ? null : condition,
    override,
  };
}
