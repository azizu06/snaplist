/**
 * Demo product catalog — the ONLY source for example items shown anywhere in
 * the product (marketing pages, Remotion videos, empty states, previews).
 *
 * Every entry's title was written by looking at the actual photo: the label
 * always matches what is visibly in the image (brand text verified where
 * present). Photos are Unsplash-licensed (free commercial use).
 *
 * Rules for consumers:
 * - Pick products via DEMO_SURFACE_ASSIGNMENTS so no two surfaces repeat the
 *   same items. If you add a surface, assign it unused products here.
 * - Never relabel an image — if you need a different product, add a new
 *   verified photo + entry instead.
 *
 * This module is intentionally directive-free (no "use client") so it can be
 * imported from server and client components alike.
 */

export type DemoProduct = {
  slug: string;
  /** Path under /public — usable directly as an <img src>. */
  image: string;
  /** Listing-style title; matches what the photo actually shows. */
  title: string;
  /** Short display name for tight UI (chips, mini-cards). */
  shortName: string;
  /** Realistic used-market price in USD. */
  price: number;
  condition: "Like new" | "Good" | "Fair";
  category: string;
  /** Which pricing tier the pipeline would plausibly fire for this item. */
  pricingStory: "barcode" | "comps" | "depreciation";
  /** 2-3 short attribute bullets — only what is actually visible in the photo. */
  details: string[];
  alt: string;
};

export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    slug: "camera",
    image: "/demo/camera.jpg",
    title: "Canon EOS 80D DSLR with 50mm lens",
    shortName: "Canon EOS 80D",
    price: 429,
    condition: "Good",
    category: "Cameras & Photo",
    pricingStory: "comps",
    details: ["Canon EOS 80D digital SLR", "50mm prime lens included", "Model badge readable on the body"],
    alt: "Black Canon EOS 80D DSLR camera with a prime lens on a wooden table",
  },
  {
    slug: "sneakers",
    image: "/demo/sneakers.jpg",
    title: "Nike Free RN Flyknit — University Red",
    shortName: "Nike Free RN",
    price: 48,
    condition: "Good",
    category: "Clothing & Shoes",
    pricingStory: "comps",
    details: ["Nike Free RN Flyknit upper", "University Red colorway", "Knit texture in clean shape"],
    alt: "Red Nike Free RN Flyknit running shoe on a red background",
  },
  {
    slug: "book",
    image: "/demo/book.jpg",
    title: "Python for Unix and Linux System Administration (O'Reilly)",
    shortName: "O'Reilly Python",
    price: 24,
    condition: "Good",
    category: "Books",
    pricingStory: "barcode",
    details: ["O'Reilly programming paperback", "Title fully readable on the cover", "Standard trade-paperback format"],
    alt: "Person holding the O'Reilly Python for Unix and Linux System Administration book",
  },
  {
    slug: "vinyl",
    image: "/demo/vinyl.jpg",
    title: "Limited teal-pressing vinyl LP",
    shortName: "Teal vinyl LP",
    price: 28,
    condition: "Like new",
    category: "Music & Vinyl",
    pricingStory: "comps",
    details: ["LP pressed in translucent teal", "Limited color pressing", "Photographed on a turntable"],
    alt: "Teal colored vinyl record spinning on a turntable in warm light",
  },
  {
    slug: "gameboy",
    image: "/demo/gameboy.jpg",
    title: "Nintendo Game Boy Color — Dandelion",
    shortName: "Game Boy Color",
    price: 95,
    condition: "Good",
    category: "Video Games & Consoles",
    pricingStory: "comps",
    details: ["Nintendo Game Boy Color", "Dandelion yellow shell", "Screen and buttons intact"],
    alt: "Yellow Nintendo Game Boy Color handheld console on a yellow background",
  },
  {
    slug: "keyboard",
    image: "/demo/keyboard.jpg",
    title: "Custom 65% mechanical keyboard — green & white keycaps",
    shortName: "65% mech keyboard",
    price: 120,
    condition: "Like new",
    category: "Computers & Accessories",
    pricingStory: "depreciation",
    details: ["Compact 65% layout", "Green and white keycap set", "Custom-built mechanical board"],
    alt: "Custom 65 percent mechanical keyboard with green and white keycaps on a desk mat",
  },
  {
    slug: "headphones",
    image: "/demo/headphones.jpg",
    title: "AfterShokz Trekz Air bone-conduction headphones",
    shortName: "AfterShokz Air",
    price: 45,
    condition: "Good",
    category: "Consumer Electronics",
    pricingStory: "comps",
    details: ["AfterShokz bone-conduction set", "Trekz Air wraparound frame", "Midnight blue finish"],
    alt: "Blue AfterShokz bone-conduction headphones on a white background",
  },
  {
    slug: "guitar",
    image: "/demo/guitar.jpg",
    title: "Taylor koa acoustic-electric guitar with cutaway",
    shortName: "Taylor acoustic",
    price: 895,
    condition: "Like new",
    category: "Musical Instruments",
    pricingStory: "comps",
    details: ["Taylor acoustic-electric", "Gloss koa top with cutaway", "Taylor logo on the headstock"],
    alt: "Taylor koa-wood acoustic-electric guitar on a stand beside a window",
  },
  {
    slug: "polaroid",
    image: "/demo/polaroid.jpg",
    title: "Polaroid Supercolor 645 CL instant camera",
    shortName: "Polaroid 645 CL",
    price: 65,
    condition: "Good",
    category: "Cameras & Photo",
    pricingStory: "comps",
    details: ["Polaroid Supercolor 645 CL", "Classic red-and-black body", "Instant film camera"],
    alt: "Red and black Polaroid Supercolor 645 CL instant camera on a white surface",
  },
  {
    slug: "mixer",
    image: "/demo/mixer.jpg",
    title: "KitchenAid stand mixer — pink",
    shortName: "KitchenAid mixer",
    price: 185,
    condition: "Good",
    category: "Home & Kitchen",
    pricingStory: "comps",
    details: ["KitchenAid stand mixer", "Pink enamel finish", "Brand band visible on the head"],
    alt: "Close-up of a pink KitchenAid stand mixer whipping batter",
  },
  {
    slug: "chess",
    image: "/demo/chess.jpg",
    title: "Vintage brass figural chess set on wooden board",
    shortName: "Brass chess set",
    price: 75,
    condition: "Fair",
    category: "Toys & Games",
    pricingStory: "depreciation",
    details: ["Vintage brass figural pieces", "Wooden chessboard included", "Ornate cast detailing"],
    alt: "Ornate vintage brass chess pieces standing on a wooden chessboard",
  },
  {
    slug: "turntable",
    image: "/demo/turntable.jpg",
    title: "Victrola belt-drive turntable — silver",
    shortName: "Victrola turntable",
    price: 68,
    condition: "Good",
    category: "Audio & Hi-Fi",
    pricingStory: "comps",
    details: ["Victrola belt-drive turntable", "Silver plinth, brand printed", "Record shown on the platter"],
    alt: "Silver Victrola belt-drive turntable with a vinyl record on the platter, beside a sketchpad",
  },
  {
    slug: "espresso",
    image: "/demo/espresso.jpg",
    title: "Stainless slim espresso machine with portafilter",
    shortName: "Espresso machine",
    price: 95,
    condition: "Good",
    category: "Home & Kitchen",
    pricingStory: "comps",
    details: ["Slim stainless espresso machine", "Portafilter and drip tray shown", "Compact single-group design"],
    alt: "Stainless-steel slim espresso machine pulling a shot into a white cup on a wooden counter",
  },
  {
    slug: "gshock",
    image: "/demo/gshock.jpg",
    title: "Casio G-Shock DW-5600 digital watch",
    shortName: "G-Shock DW-5600",
    price: 42,
    condition: "Good",
    category: "Watches",
    pricingStory: "comps",
    details: ["Casio G-Shock DW-5600", "Classic square case", "Digital display, resin strap"],
    alt: "Hand holding a black Casio G-Shock DW-5600 digital watch",
  },
];

export const DEMO_PRODUCTS_BY_SLUG: Record<string, DemoProduct> =
  Object.fromEntries(DEMO_PRODUCTS.map((p) => [p.slug, p]));

/**
 * Which surface uses which products. Keeps imagery varied across the app —
 * no product should headline more than one surface.
 */
export const DEMO_SURFACE_ASSIGNMENTS: Record<string, string[]> = {
  // --- Remotion demo-video suite (remotion/suite; see remotion/INTEGRATION.md) ---
  "hero-video": ["polaroid", "gameboy", "gshock"], // public/hero-demo.mp4 — vision-showcase acts 1–3
  "step-snap": ["guitar"], // public/demo/steps/snap.mp4
  "step-identify": ["camera"], // public/demo/steps/identify.mp4
  "step-price": ["sneakers"], // public/demo/steps/price.mp4
  "step-write": ["mixer"], // public/demo/steps/write.mp4
  "step-publish": ["keyboard"], // public/demo/steps/publish.mp4
  "buyer-qa": ["chess"], // public/demo/buyer-qa.mp4
  // --- Static page surfaces (post v3 passes; reflects actual usage) ---
  "landing-carousel": ["camera", "book", "sneakers", "chess", "headphones"],
  "landing-storefronts": ["keyboard"],
  // /features was deleted in r5 (redirects to /how-it-works); the waterfall
  // explorer now lives only on /how-it-works, last section before the CTA.
  "hiw-waterfall": ["guitar"],
  "how-it-works": ["gameboy"], // + embeds the step-* clips above
  // Hero ScanShowcase on /how-it-works — a deliberate 10-product montage
  // (scanning-beam cycle), exempt from the one-surface rule by design.
  "hiw-hero-scan": [
    "camera",
    "book",
    "sneakers",
    "vinyl",
    "gameboy",
    "headphones",
    "guitar",
    "polaroid",
    "espresso",
    "gshock",
  ],
  // ui-r4: mixer.jpg is an extreme close-up that doesn't read as a sellable
  // product on the About hero — replaced with the verified turntable photo.
  // The mixer entry stays (the step-write Remotion clip still uses it).
  "about-price-report": ["turntable"],
  // r5.1: the upload page's "one photo in, a finished listing out" example
  // strip was removed (how-it-works already tells that story) — gameboy and
  // vinyl remain in use via the step clips and the hiw scan montage.
  // r5: espresso freed up when the About FAQ anchor card was removed; the
  // folder now pops items that no landing surface features.
  "dashboard-folder": ["gshock", "espresso", "turntable"],
};
