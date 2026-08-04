/**
 * Marketing surface content and outbound destinations (issue #191).
 *
 * Every claim on the public site has to survive the PRD's out-of-scope list and
 * the export-pack honesty rule, so the copy lives here as data rather than
 * scattered through JSX. `src/app/(marketing)/marketing.test.tsx` reads these
 * exports and derives its assertions from product capability instead of pinning
 * literal sentences — the failure mode recorded on #191 was a copy test that
 * held a retired claim green because nobody remembered to update the literal
 * alongside the behavior.
 *
 * Two destinations are unresolved at build time and are deliberately env-driven
 * rather than hardcoded: SnapList has no App Store listing until #380 submits,
 * and no published support address exists in this repository. Both render an
 * honest unavailable state when unset instead of a dead link.
 */

export const HERO = {
  title: "Turn photos into a listing you approve.",
} as const;

export const WHY = {
  title: "Why choose SnapList?",
} as const;

/**
 * Trophy Wall section copy.
 *
 * v6 wrote this section around selling: `Watch the pile get smaller.` and `See
 * every item you have sold in one place`. Nothing in this repository ever writes
 * a sold listing status, and post-sale operations are retired by ADR-0008, so
 * that framing advertises a capability the product does not have. The copy is
 * rewritten around what Trophy Wall actually is in the PRD — one chronological
 * place showing each item's real state. See the #191 PR body.
 */
export const TROPHY_WALL = {
  title: "Trophy Wall",
} as const;

export const FAQ_TITLE = "Frequently asked questions";

export const FOOTER = {
  title: "Get first access to SnapList.",
} as const;

export const FEATURES_TITLE = "What does SnapList include?";

/** Ordered feature-explorer steps. Index is the tab order. */
export const FEATURE_STEPS = [
  {
    id: "scan",
    title: "Scan",
    /** Marks a screen the design package has not frozen for the native client. */
    candidate: false,
    body:
      "Take 1 to 5 photos yourself and control the shutter. Keep the views you want, "
      + "add another angle when the item needs it, and decide when the photo set is "
      + "ready for a draft.",
  },
  {
    id: "photo-review",
    title: "Photo Review",
    candidate: true,
    body:
      "Reorder, crop, rotate, and remove photos before SnapList drafts the listing. "
      + "Review the complete set, make your local edits, and choose the final order "
      + "before the photos move forward.",
  },
  {
    id: "listing-review",
    title: "Listing Review",
    candidate: false,
    body:
      "Review and edit the title, condition, item details, description, photos, and "
      + "price. Compare every field with the item in front of you, then confirm the "
      + "version you want to use.",
  },
  {
    id: "publish",
    title: "Publish",
    candidate: false,
    body:
      "Confirm to publish directly to eBay. For Mercari, Facebook Marketplace, and "
      + "Depop, SnapList prepares a handoff that you finish yourself, so nothing "
      + "leaves for those marketplaces without you.",
  },
] as const;

export type FeatureStep = (typeof FEATURE_STEPS)[number];

export const VALUE_CARDS = [
  {
    id: "review",
    title: "Editable listing review",
    body:
      "Review and edit the title, condition, item details, description, photos, and "
      + "price before anything leaves SnapList.",
  },
  {
    id: "evidence",
    title: "Sold-price evidence",
    body:
      "See sold-price matches when they exist. When evidence is missing, SnapList "
      + "says so and you choose the price.",
  },
  {
    id: "publish",
    title: "eBay after confirmation",
    body:
      "Publish to eBay only after you confirm. Other supported marketplaces use a "
      + "prepared handoff you finish yourself.",
  },
] as const;

/** v6-restyled continuation of the live MagicBento grid. */
export const MARKETING_BENTO_CARDS = [
  {
    label: "Pricing evidence",
    title: "Sold prices, not asking prices",
    description:
      "SnapList surfaces pricing from actual sold prices when evidence is available. When it is not, the estimate stays clearly labeled.",
    className: "lg:col-span-2",
  },
  {
    label: "Voice context",
    title: "Add seller context with a voice note",
    description:
      "A voice note of up to 15 seconds adds seller context to your item. It does not replace the photos or verified evidence.",
  },
  {
    label: "Review",
    title: "Edit before anything leaves SnapList",
    description:
      "Review and edit the title, condition, item details, description, photos, and price before you confirm an eBay publish.",
  },
  {
    label: "Export packs",
    title: "Prepared for your share sheet",
    description:
      "Facebook Marketplace, Mercari, and Depop get prepared text and photos. You finish the destination form yourself.",
    className: "lg:col-span-2",
  },
  {
    label: "Confirmation",
    title: "eBay publishes only after you confirm",
    description:
      "SnapList publishes to eBay only after your explicit confirmation.",
  },
  {
    label: "Your draft",
    title: "Keep one clear next step",
    description:
      "Trophy Wall keeps each item in one chronological place, from analyzing to ready to review to a prepared or published result.",
  },
] as const;

/**
 * Trophy Wall rows shown in the illustrative phone.
 *
 * The states are the PRD's Trophy Wall vocabulary. `Sold` is deliberately absent:
 * nothing in this repository ever writes a sold listing status, and post-sale
 * workflows are retired by ADR-0008, so a sold badge would advertise a capability
 * the product does not have. See the #191 PR body.
 */
export const TROPHY_WALL_ROWS = [
  { id: "scarf", title: "Wool blend scarf", state: "Published" },
  { id: "lamp", title: "Ceramic table lamp", state: "Prepared" },
  { id: "camera", title: "Vintage film camera", state: "Ready to review" },
] as const;

export const FAQ_ITEMS = [
  {
    id: "account",
    question: "Do I need an account before I start?",
    answer:
      "No. You can create your first usable listing without an account. Sign in only "
      + "when you choose Publish to eBay.",
  },
  {
    id: "photos",
    question: "How many photos does SnapList use?",
    answer:
      "One to five photos per item. You take them yourself and decide when each shot "
      + "is ready.",
  },
  {
    id: "edit",
    question: "Can I edit the listing before it publishes?",
    answer:
      "Yes. The title, condition, item details, description, photos, and price are all "
      + "editable. Nothing publishes until you confirm.",
  },
  {
    id: "price",
    question: "How does SnapList decide the price?",
    answer:
      "SnapList shows sold-price matches when they exist. When there are no matches, "
      + "it tells you and you set the price.",
  },
  {
    id: "marketplaces",
    question: "Which marketplaces can SnapList publish to?",
    answer:
      "SnapList publishes directly to eBay after you confirm. Mercari, Facebook "
      + "Marketplace, and Depop are assisted handoffs you finish in their own apps.",
  },
] as const;

/**
 * The App Store product page, once #380 submits one.
 *
 * The v6 design carries this as the inert token `APP_STORE_DESTINATION_PENDING` on
 * exactly three controls. Returning `null` keeps them inert and honest rather than
 * pointing a download button at a page that does not exist.
 */
export function appStoreURL(): string | null {
  return normalizeHttpsURL(process.env.NEXT_PUBLIC_APP_STORE_URL);
}

/**
 * Where a seller reaches a person. App Review requires a working support URL, so
 * `/support` always renders; this only decides whether it can name a channel.
 */
export function supportEmail(): string | null {
  const value = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim();
  if (!value) return null;
  // A bare local part or a missing domain would render a mailto: that silently
  // opens an unaddressed draft, which reads as a working channel and is not one.
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value) ? value : null;
}

function normalizeHttpsURL(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    // Anything that is not an absolute https URL would render a link that either
    // resolves relative to snaplist.dev or does not resolve at all.
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
