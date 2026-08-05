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

const HERO_BEFORE_ACCENT = "Turn photos into a";
const HERO_ACCENT_WORD = "listing";
const HERO_AFTER_ACCENT = "you approve.";

export const HERO = {
  title: [HERO_BEFORE_ACCENT, HERO_ACCENT_WORD, HERO_AFTER_ACCENT].join(" "),
  beforeAccent: HERO_BEFORE_ACCENT,
  accentWord: HERO_ACCENT_WORD,
  afterAccent: HERO_AFTER_ACCENT,
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
  body: "See each item move from analysis to an editable draft, then a prepared handoff or an eBay result you confirmed.",
  states: ["Analyzing", "Ready to review", "Published to eBay"],
} as const;

export const FAQ_TITLE = "Frequently asked questions";

export const FOOTER = {
  brandName: "SnapList",
  tagline: "Photos in. Listing you approve.",
  legalLinks: [
    { href: "/privacy", label: "Privacy" },
    { href: "/terms", label: "Terms" },
    { href: "/support", label: "Contact" },
  ],
} as const;

export const TERMS = {
  content:
    "You keep your rights in the photos and optional voice context you provide. You give "
    + "SnapList permission to process them only to identify your item, prepare an editable draft, "
    + "find price evidence, and deliver the features you choose to use.",
  decisions:
    "You review the listing, price, and condition before you use them. SnapList publishes to "
    + "eBay only after your explicit confirmation. For Facebook Marketplace, Mercari, and Depop, "
    + "SnapList prepares a handoff that you finish yourself.",
} as const;

export const FEATURES_TITLE = "What does SnapList include?";
export const LOOP_TITLE = "From camera roll to every storefront.";

/** Short, complete item names so every carousel card fits without clipping. */
export const MARKETING_CAROUSEL_TITLES: Record<string, string> = {
  "reseller-ps5": "PlayStation 5 with DualSense",
  "reseller-iphone-15": "iPhone 15, blue",
  "reseller-sony-camera": "Sony camera with lenses",
  "reseller-switch-2": "Nintendo Switch 2 console",
  "reseller-dualsense": "DualSense wireless controller",
  "reseller-charizard": "Holographic Charizard card",
  "reseller-air-jordan-pair": "White Air Jordan sneakers",
  "reseller-keychron": "Keychron mechanical keyboard",
  "reseller-airpods-max": "AirPods Max, space gray",
  "reseller-galaxy-watch": "Galaxy Watch Ultra and Watch 7",
};

/** Ordered feature-explorer steps. Index is the tab order. */
export const FEATURE_STEPS = [
  {
    id: "scan",
    title: "Scan",
    body:
      "Take 1 to 5 photos, then add one optional voice note up to 15 seconds before you start a draft.",
  },
  {
    id: "photo-review",
    title: "Photo Review",
    body:
      "Reorder, crop, rotate, or remove photos before SnapList drafts the listing, then choose the final order for the item.",
  },
  {
    id: "listing-review",
    title: "Listing Review",
    body:
      "Review and edit the title, condition, details, photos, and price so every field matches the item before you confirm it.",
  },
  {
    id: "publish",
    title: "Publish",
    body:
      "Confirm before eBay publishing. Facebook Marketplace, Mercari, and Depop get a prepared handoff you finish.",
  },
  {
    id: "trophy-wall",
    title: TROPHY_WALL.title,
    body:
      "Follow each item from analysis to review, then return to confirmed eBay results or prepared handoffs that you finish.",
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

/** Uniform Why-choose grid: one equal card per product truth. */
export const MARKETING_BENTO_CARDS = [
  {
    icon: "chart" as const,
    title: "Sold-price evidence",
    description:
      "See verified sold prices when available. When evidence is missing, SnapList labels the estimate.",
  },
  {
    icon: "mic" as const,
    title: "Voice notes add context",
    description:
      "Add up to 15 seconds of context. Photos and verified evidence remain the source of truth.",
  },
  {
    icon: "pencil" as const,
    title: "Edit every detail",
    description:
      "Review the title, condition, photos, details, and price before you confirm an eBay publish.",
  },
  {
    icon: "share" as const,
    title: "Prepared handoffs",
    description:
      "Facebook Marketplace, Mercari, and Depop get prepared text and photos. You finish each form yourself.",
  },
  {
    icon: "check" as const,
    title: "eBay needs your confirmation",
    description:
      "SnapList publishes only to eBay. It never publishes there until you explicitly confirm.",
  },
  {
    icon: "trophy" as const,
    title: TROPHY_WALL.title,
    description:
      "Follow every draft from intake to review. See eBay publishes and prepared handoffs in one place.",
  },
] as const;

/** Trophy Wall rows retained for the marketing phone illustration. */
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
