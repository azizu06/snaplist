/**
 * Demo product catalog — the ONLY source for example items shown anywhere in
 * the product (marketing pages, empty states, previews).
 *
 * Every entry's title was written by looking at the actual photo: the label
 * always matches what is visibly in the image (brand text verified where
 * present). The newly sourced primary reseller set has per-file license and
 * transformation records in docs/demo-asset-provenance.md. The small dashboard
 * folder set retains its original repository provenance.
 *
 * Rules for consumers:
 * - Pick products via DEMO_SURFACE_ASSIGNMENTS. Prefer the audience's clearest
 *   category story over artificial cross-surface uniqueness; a strong reseller
 *   example may repeat when it is the honest best fit.
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
    slug: "kettlebell",
    image: "/demo/kettlebell.jpg",
    title: "Cast iron kettlebell, 35 lb / 16 kg",
    shortName: "Kettlebell",
    price: 30,
    condition: "Good",
    category: "Sporting Goods",
    pricingStory: "comps",
    details: ["35 lb / 16 kg cast iron", "Single-cast handle, no chips or cracks", "Light surface wear from home use"],
    alt: "A single black cast iron 35 lb kettlebell resting on a mat on the floor in natural window light",
  },
  {
    slug: "binoculars",
    image: "/demo/binoculars.jpg",
    title: "Antique French opera glasses, brass and leather",
    shortName: "Binoculars",
    price: 48,
    condition: "Good",
    category: "Cameras & Photo",
    pricingStory: "comps",
    details: ["Vintage brass and leather barrels", "Engraved 'PARIS' on the eyepiece ring", "Compact opera/field glass style, glass intact"],
    alt: "Vintage brass and leather opera-glass binoculars resting on a polished wooden table in natural light",
  },
  {
    slug: "sewingmachine",
    image: "/demo/sewingmachine.jpg",
    title: "Brother 1034D serger overlock sewing machine with manual",
    shortName: "Sewing machine",
    price: 135,
    condition: "Good",
    category: "Crafts",
    pricingStory: "comps",
    details: ["Brother Lock 1034D 3/4-thread serger", "Includes original instruction manual", "Color-coded threading guides intact"],
    alt: "A used Brother 1034D serger sewing machine on a wooden table by a window with its manual open in front of it",
  },
  {
    slug: "reseller-ps5",
    image: "/demo/reseller/ps5.webp",
    title: "Sony PlayStation 5 console with DualSense controller",
    shortName: "PlayStation 5 bundle",
    price: 379,
    condition: "Good",
    category: "Video Games & Consoles",
    pricingStory: "comps",
    details: [
      "PlayStation 5 console and DualSense controller",
      "White-and-black finish",
      "Console and controller shown together",
    ],
    alt: "White Sony PlayStation 5 console with a matching DualSense controller resting on top",
  },
  {
    slug: "reseller-dualsense",
    image: "/demo/reseller/dualsense.webp",
    title: "Sony PlayStation 5 DualSense wireless controller",
    shortName: "PS5 DualSense controller",
    price: 49,
    condition: "Good",
    category: "Video Games & Consoles",
    pricingStory: "comps",
    details: ["Sony DualSense controller", "White-and-black finish", "Buttons and thumbsticks shown clearly"],
    alt: "White and black Sony PlayStation 5 DualSense controller on a vivid red surface",
  },
  {
    slug: "reseller-sony-camera",
    image: "/demo/reseller/camera.webp",
    title: "Sony mirrorless camera body with three lenses",
    shortName: "Sony Alpha camera kit",
    price: 895,
    condition: "Good",
    category: "Cameras & Photo",
    pricingStory: "comps",
    details: ["Sony mirrorless camera body", "Three lenses shown", "Black camera-and-lens kit"],
    alt: "Black Sony mirrorless camera body arranged with three camera lenses on a dark surface",
  },
  {
    slug: "reseller-iphone-15",
    image: "/demo/reseller/iphone-15.webp",
    title: "Apple iPhone 15, blue",
    shortName: "iPhone 15",
    price: 499,
    condition: "Good",
    category: "Cell Phones & Accessories",
    pricingStory: "comps",
    details: ["Apple iPhone 15", "Blue finish", "Dual-camera rear system"],
    alt: "Blue Apple iPhone 15 resting in sunlight with its dual-camera system visible",
  },
  {
    slug: "reseller-airpods-max",
    image: "/demo/reseller/airpods-max.webp",
    title: "Apple AirPods Max, space gray",
    shortName: "AirPods Max",
    price: 329,
    condition: "Good",
    category: "Consumer Electronics",
    pricingStory: "comps",
    details: ["Apple AirPods Max", "Space gray finish", "Over-ear design"],
    alt: "Space gray Apple AirPods Max over-ear headphones on a warm brown surface",
  },
  {
    slug: "reseller-keychron",
    image: "/demo/reseller/keychron.webp",
    title: "Keychron mechanical keyboard, black and orange",
    shortName: "Keychron keyboard",
    price: 79,
    condition: "Like new",
    category: "Computers & Accessories",
    pricingStory: "comps",
    details: ["Keychron mechanical keyboard", "Black keycaps with orange accents", "Compact desktop layout"],
    alt: "Compact black Keychron mechanical keyboard with orange accent keys on a marble surface",
  },
  {
    slug: "reseller-charizard",
    image: "/demo/reseller/charizard.webp",
    title: "Holographic Charizard Pokémon trading card",
    shortName: "Charizard trading card",
    price: 48,
    condition: "Good",
    category: "Collectibles",
    pricingStory: "comps",
    details: ["Charizard Pokémon card", "Holographic finish", "Single unslabbed card"],
    alt: "Holographic Charizard Pokémon trading card standing upright on a dark surface",
  },
  {
    slug: "reseller-air-jordan-pair",
    image: "/demo/reseller/air-jordan-pair.webp",
    title: "White Air Jordan sneakers, pair",
    shortName: "White Air Jordan pair",
    price: 110,
    condition: "Good",
    category: "Clothing & Shoes",
    pricingStory: "comps",
    details: ["Pair of Air Jordan sneakers", "White leather uppers", "Red Wings logos on the heels"],
    alt: "Pair of white Air Jordan sneakers photographed heel-first against a dark background",
  },
  {
    slug: "reseller-switch-2",
    image: "/demo/reseller/switch-2.webp",
    title: "Nintendo Switch 2 handheld console",
    shortName: "Nintendo Switch 2",
    price: 415,
    condition: "Like new",
    category: "Video Games & Consoles",
    pricingStory: "comps",
    details: ["Nintendo Switch 2 console", "Joy-Con controllers attached", "Screen and controls shown"],
    alt: "Nintendo Switch 2 handheld console with attached Joy-Con controllers in soft window light",
  },
  {
    slug: "reseller-galaxy-watch",
    image: "/demo/reseller/galaxy-watches.webp",
    title: "Samsung Galaxy Watch Ultra and Watch 7 pair",
    shortName: "Samsung Galaxy watches",
    price: 399,
    condition: "Like new",
    category: "Watches",
    pricingStory: "comps",
    details: ["Two Samsung Galaxy smartwatches", "Watch Ultra and Watch 7", "Displays powered on"],
    alt: "Two powered-on Samsung Galaxy smartwatches held side by side",
  },
];

export const DEMO_PRODUCTS_BY_SLUG: Record<string, DemoProduct> =
  Object.fromEntries(DEMO_PRODUCTS.map((p) => [p.slug, p]));

/** Runtime surfaces that consume the retained catalog. */
export const DEMO_SURFACE_ASSIGNMENTS: Record<string, string[]> = {
  // #136: a deliberate tech, gaming, collectibles, and streetwear haul.
  "landing-carousel": [
    "reseller-ps5",
    "reseller-iphone-15",
    "reseller-sony-camera",
    "reseller-switch-2",
    "reseller-dualsense",
    "reseller-charizard",
    "reseller-air-jordan-pair",
    "reseller-keychron",
    "reseller-airpods-max",
    "reseller-galaxy-watch",
  ],
  // The anchor PlayStation 5 listing rendered three platform-fluent ways.
  "landing-storefronts": ["reseller-ps5"],
  // Hero ScanShowcase — the same coherent haul, with the PS5 anchor first.
  // Repetition across primary surfaces is intentional: this is one seller's
  // inventory, not a grab bag assembled independently per component.
  "landing-hero-scan": [
    "reseller-ps5",
    "reseller-iphone-15",
    "reseller-sony-camera",
    "reseller-switch-2",
    "reseller-charizard",
    "reseller-air-jordan-pair",
    "reseller-keychron",
    "reseller-airpods-max",
  ],
  // Three items exclusive to the logged-in dashboard folder (ordered
  // shortest→longest name for the folder's narrow→wide papers).
  "dashboard-folder": ["kettlebell", "binoculars", "sewingmachine"],
};
