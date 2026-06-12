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
    alt: "Ornate vintage brass chess pieces standing on a wooden chessboard",
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
  "hero-video": ["camera", "book", "sneakers"], // current hero-demo.mp4 acts
  "landing-features": ["polaroid", "vinyl", "gshock"],
  "how-it-works": ["gameboy", "guitar", "mixer"],
  "dashboard-folder": ["keyboard", "chess", "headphones"],
  "app-empty-states": ["vinyl", "gameboy"],
};
