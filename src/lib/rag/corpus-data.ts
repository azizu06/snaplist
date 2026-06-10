import { type ReferenceItem, referenceItemSchema } from "./types";

/**
 * The seeded **reference corpus** — hero-domain-weighted example items with realistic
 * used prices and good, platform-competent listing copy. Used to (a) corroborate
 * pricing and (b) few-shot the listing generator (PRD "RAG (pgvector)").
 *
 * HONESTY DISCLOSURE: this corpus is REALISTIC-SYNTHETIC — hand-authored exemplars,
 * not scraped real listings. Prices are plausible used/resale values, not live comps.
 * The README states this. The architecture (table + retrieval) is real; only the seed
 * content is synthetic, which is exactly the cold-start avoidance the PRD allows.
 *
 * Weighting follows the hero domain (CONTEXT.md): books/media, electronics, board
 * games, branded gear are well represented; a couple of generics exist so the
 * graceful-degradation path has something to retrieve (honestly low value).
 */

const items: ReferenceItem[] = [
  // ---------------- Electronics (hero) ----------------
  {
    sourceRef: "ref-electronics-sony-wh1000xm4",
    category: "electronics",
    brand: "Sony",
    model: "WH-1000XM4",
    price: 168,
    content:
      "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones — Black. Excellent used " +
      "condition, lightly worn ear cushions, no scratches. Industry-leading ANC, " +
      "30-hour battery, multipoint Bluetooth, touch controls. Includes original case, " +
      "USB-C and 3.5mm cables. Tested and fully functional; resets to factory cleanly.",
    metadata: { condition: "good", platform: "ebay", specs: { anc: true, battery_h: 30 } },
  },
  {
    sourceRef: "ref-electronics-bose-qc35ii",
    category: "electronics",
    brand: "Bose",
    model: "QuietComfort 35 II",
    price: 110,
    content:
      "Bose QuietComfort 35 II Noise Cancelling Headphones, Silver. Good used condition " +
      "with minor headband wear. Comfortable all-day fit, strong ANC, Google Assistant " +
      "button. Comes with carrying case and audio cable. Battery holds a full charge.",
    metadata: { condition: "good", platform: "ebay" },
  },
  {
    sourceRef: "ref-electronics-apple-airpodspro2",
    category: "electronics",
    brand: "Apple",
    model: "AirPods Pro 2",
    price: 145,
    content:
      "Apple AirPods Pro (2nd Generation) with MagSafe USB-C case. Like-new, sanitized, " +
      "fresh ear tips. Active Noise Cancellation, Adaptive Transparency, Personalized " +
      "Spatial Audio. Serial verified, not reported lost. Original box and tips included.",
    metadata: { condition: "like-new", platform: "ebay" },
  },
  {
    sourceRef: "ref-electronics-nintendo-switch-oled",
    category: "electronics",
    brand: "Nintendo",
    model: "Switch OLED",
    price: 235,
    content:
      "Nintendo Switch OLED Model (White) — vibrant 7-inch screen, wide stand, dock " +
      "included. Good condition, screen protector applied since day one, no dead pixels. " +
      "Joy-Cons drift-free. Bundle includes dock, HDMI, AC adapter, two Joy-Cons.",
    metadata: { condition: "good", platform: "ebay" },
  },
  {
    sourceRef: "ref-electronics-kindle-paperwhite",
    category: "electronics",
    brand: "Amazon",
    model: "Kindle Paperwhite",
    price: 72,
    content:
      "Amazon Kindle Paperwhite (11th Gen, 6.8-inch) — 8GB, ad-supported. Glare-free " +
      "display, adjustable warm light, weeks of battery, IPX8 waterproof. Good condition, " +
      "screen flawless, light wear on back. Account de-registered and factory reset.",
    metadata: { condition: "good", platform: "ebay" },
  },

  // ---------------- Books / media (hero — ISBN tier) ----------------
  {
    sourceRef: "ref-books-pragmatic-programmer",
    category: "books",
    brand: "Addison-Wesley",
    model: "The Pragmatic Programmer 20th Anniversary",
    price: 28,
    content:
      "The Pragmatic Programmer: Your Journey to Mastery, 20th Anniversary Edition " +
      "(Hunt & Thomas). Hardcover, ISBN 9780135957059. Gently read, no markings, tight " +
      "binding, clean pages. A modern classic on software craftsmanship. Ships fast.",
    metadata: { condition: "like-new", isbn: "9780135957059", format: "hardcover" },
  },
  {
    sourceRef: "ref-books-clean-code",
    category: "books",
    brand: "Prentice Hall",
    model: "Clean Code",
    price: 22,
    content:
      "Clean Code: A Handbook of Agile Software Craftsmanship by Robert C. Martin. " +
      "Paperback, ISBN 9780132350884. Good used condition, light cover wear, no " +
      "highlighting inside. Essential reading on writing maintainable code.",
    metadata: { condition: "good", isbn: "9780132350884", format: "paperback" },
  },
  {
    sourceRef: "ref-books-dune",
    category: "books",
    brand: "Ace",
    model: "Dune",
    price: 12,
    content:
      "Dune by Frank Herbert — mass market paperback, ISBN 9780441172719. Classic " +
      "science fiction epic. Reading copy in good condition with creased spine; all " +
      "pages intact and legible. Great entry into the series.",
    metadata: { condition: "good", isbn: "9780441172719", format: "paperback" },
  },

  // ---------------- Board games (hero) ----------------
  {
    sourceRef: "ref-boardgames-catan",
    category: "board-games",
    brand: "Catan Studio",
    model: "Catan (Base Game)",
    price: 32,
    content:
      "Catan Base Game (5th Edition) — complete and counted, all hexes, cards, and " +
      "wooden pieces present. Box shows light shelf wear. Modern gateway strategy " +
      "classic for 3-4 players, 60-90 min. From a smoke-free home.",
    metadata: { condition: "good", platform: "ebay", complete: true },
  },
  {
    sourceRef: "ref-boardgames-ticket-to-ride",
    category: "board-games",
    brand: "Days of Wonder",
    model: "Ticket to Ride",
    price: 35,
    content:
      "Ticket to Ride (USA edition) by Days of Wonder. Complete with all 240 colored " +
      "train cars, destination tickets, and board. Very good condition, pieces bagged. " +
      "Easy-to-learn route-building game, 2-5 players. Family favorite.",
    metadata: { condition: "very-good", complete: true },
  },
  {
    sourceRef: "ref-boardgames-wingspan",
    category: "board-games",
    brand: "Stonemaier Games",
    model: "Wingspan",
    price: 45,
    content:
      "Wingspan by Stonemaier Games — award-winning engine-building game about birds. " +
      "Complete with bird cards, egg miniatures, dice tower, and food tokens. Excellent " +
      "condition, organized insert. Beautiful artwork, 1-5 players.",
    metadata: { condition: "like-new", complete: true },
  },

  // ---------------- Branded gear (hero) ----------------
  {
    sourceRef: "ref-gear-patagonia-nano-puff",
    category: "branded-gear",
    brand: "Patagonia",
    model: "Nano Puff Jacket",
    price: 95,
    content:
      "Patagonia Nano Puff Insulated Jacket, Men's Medium, Black. Lightweight, " +
      "packable, PrimaLoft Gold insulation, wind-resistant shell. Good used condition, " +
      "no rips or stains, full-length zipper smooth. Authentic, ships from a pet-free home.",
    metadata: { condition: "good", size: "M", color: "black" },
  },
  {
    sourceRef: "ref-gear-yeti-rambler",
    category: "branded-gear",
    brand: "YETI",
    model: "Rambler 20oz Tumbler",
    price: 22,
    content:
      "YETI Rambler 20 oz Stainless Steel Vacuum Insulated Tumbler with MagSlider lid. " +
      "Stainless finish, dishwasher safe, keeps drinks cold for hours. Good condition, " +
      "minor surface scuffs, no dents. Authentic YETI.",
    metadata: { condition: "good" },
  },
  {
    sourceRef: "ref-gear-stanley-quencher",
    category: "branded-gear",
    brand: "Stanley",
    model: "Quencher H2.0 40oz",
    price: 30,
    content:
      "Stanley Quencher H2.0 FlowState Tumbler, 40 oz, Charcoal. Reusable straw, " +
      "car-cup-holder base, double-wall vacuum insulation. Very good condition, lightly " +
      "used, no odors. Includes original straw and lid.",
    metadata: { condition: "very-good", color: "charcoal" },
  },

  // ---------------- Generic (graceful degradation — honestly low value) ----------------
  {
    sourceRef: "ref-generic-ceramic-mug",
    category: "generic",
    price: 6,
    content:
      "Ceramic coffee mug, 12 oz, plain white, no chips or cracks. Microwave and " +
      "dishwasher safe. Used but clean. Unbranded household item.",
    metadata: { condition: "good" },
  },
  {
    sourceRef: "ref-generic-desk-lamp",
    category: "generic",
    price: 14,
    content:
      "Adjustable LED desk lamp, gooseneck arm, USB-powered, three brightness levels. " +
      "Works perfectly, light wear on base. Generic / unbranded. Good for a home office.",
    metadata: { condition: "good" },
  },
];

/**
 * The validated reference corpus. Validating at module load means a malformed seed
 * entry fails fast (and in tests) rather than at INSERT time.
 */
export const REFERENCE_CORPUS: ReferenceItem[] = items.map((it) =>
  referenceItemSchema.parse(it),
);

/** The text we embed for each reference item — brand/model/category + the copy. */
export function corpusEmbeddingText(item: ReferenceItem): string {
  return [item.brand, item.model, item.category, item.content]
    .filter(Boolean)
    .join(" ");
}
