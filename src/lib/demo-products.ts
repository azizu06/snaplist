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
    title: "Nike Invincible Run 3, grey and orange",
    shortName: "Nike Invincible 3",
    price: 48,
    condition: "Good",
    category: "Clothing & Shoes",
    pricingStory: "comps",
    details: ["Nike Invincible Run 3 running shoes", "Grey knit upper, orange sole", "Worn, scuffing on the sole"],
    alt: "Close-up of worn grey and orange Nike Invincible Run 3 running shoes on concrete",
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
    title: "Nintendo Game Boy Color, Pokémon edition",
    shortName: "Game Boy Color",
    price: 110,
    condition: "Good",
    category: "Video Games & Consoles",
    pricingStory: "comps",
    details: ["Nintendo Game Boy Color, yellow Pokémon edition", "Pikachu graphic on the shell", "Screen and buttons intact"],
    alt: "Yellow Pokémon-edition Nintendo Game Boy Color resting on a pile of Pokémon cards",
  },
  {
    slug: "keyboard",
    image: "/demo/keyboard.jpg",
    title: "Custom 65% mechanical keyboard, green & white keycaps",
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
    title: "Black over-ear wireless headphones",
    shortName: "Wireless headphones",
    price: 55,
    condition: "Good",
    category: "Consumer Electronics",
    pricingStory: "comps",
    details: ["Over-ear wireless headphones", "Matte black with a cream inner band", "Lightly used, works fully"],
    alt: "Black over-ear wireless headphones with a cream inner band on a worn wooden table",
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
    title: "Polaroid 636 CloseUp instant camera",
    shortName: "Polaroid 636",
    price: 65,
    condition: "Good",
    category: "Cameras & Photo",
    pricingStory: "comps",
    details: ["Polaroid 636 CloseUp instant camera", "Classic black 600-series body", "Held in hand, fully shown"],
    alt: "Hand holding a black vintage Polaroid 636 CloseUp instant camera against a cork wall",
  },
  {
    slug: "mixer",
    image: "/demo/mixer.jpg",
    title: "KitchenAid stand mixer, pink",
    shortName: "KitchenAid mixer",
    price: 185,
    condition: "Good",
    category: "Home & Kitchen",
    pricingStory: "comps",
    details: ["Pink KitchenAid tilt-head stand mixer", "Glass mixing bowl included", "Brand printed on the head"],
    alt: "Blush-pink KitchenAid stand mixer with a glass bowl on a home kitchen counter",
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
    title: "Victrola belt-drive turntable, silver",
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
    title: "Sage Barista espresso machine with built-in grinder",
    shortName: "Espresso machine",
    price: 280,
    condition: "Good",
    category: "Home & Kitchen",
    pricingStory: "comps",
    details: ["Stainless espresso machine with built-in grinder", "Portafilter, tamper, and tamping station", "Used with light patina, runs well"],
    alt: "Used stainless Sage Barista espresso machine with a built-in grinder on a sunlit kitchen counter",
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
  // --- r6: visibly-USED items (owner: the carousel should reinforce that ---
  // --- SnapList sells secondhand — worn, dusty, broken-in, not showroom) ---
  {
    slug: "macbook",
    image: "/demo/macbook.jpg",
    title: "Apple MacBook Pro 13-inch, Retina display",
    shortName: "MacBook Pro 13″",
    price: 295,
    condition: "Good",
    category: "Computers & Accessories",
    pricingStory: "comps",
    details: ["Apple MacBook Pro 13-inch", "macOS menu bar on screen", "Silver aluminum unibody"],
    alt: "Open Apple MacBook Pro 13-inch sitting on an outdoor wooden table",
  },
  {
    slug: "boots",
    image: "/demo/boots.jpg",
    title: "Tan leather lace-up boots, broken in",
    shortName: "Leather boots",
    price: 58,
    condition: "Fair",
    category: "Clothing & Shoes",
    pricingStory: "comps",
    details: ["Tan leather lace-up boots", "Visible wear at the toes", "Lug rubber outsoles"],
    alt: "Person lacing up a pair of worn tan leather boots on asphalt",
  },
  {
    slug: "bicycle",
    image: "/demo/bicycle.jpg",
    title: "Vintage Peugeot single-speed road bike",
    shortName: "Peugeot road bike",
    price: 240,
    condition: "Good",
    category: "Sporting Goods",
    pricingStory: "comps",
    details: ["Peugeot decal on the frame", "Single-speed drivetrain", "Brown leather saddle and grips"],
    alt: "Silver vintage Peugeot single-speed bicycle leaning against a dark wall",
  },
  {
    slug: "drill",
    image: "/demo/drill.jpg",
    title: "Milwaukee M18 cordless drill with XC battery",
    shortName: "Milwaukee M18 drill",
    price: 79,
    condition: "Good",
    category: "Tools & Workshop",
    pricingStory: "comps",
    details: ["Milwaukee M18 cordless drill", "REDLITHIUM XC battery pack", "Honest jobsite dust and wear"],
    alt: "Red Milwaukee M18 cordless drill lying on a dusty workshop floor",
  },
  {
    slug: "skateboard",
    image: "/demo/skateboard.jpg",
    title: "Complete skateboard, multicolor graphic deck",
    shortName: "Skateboard",
    price: 45,
    condition: "Fair",
    category: "Sporting Goods",
    pricingStory: "depreciation",
    details: ["Complete with trucks and wheels", "Multicolor graphic deck", "Wear consistent with regular use"],
    alt: "Skateboard with a colorful graphic deck leaning against a yellow wall",
  },
  {
    slug: "crt-tv",
    image: "/demo/crt-tv.jpg",
    title: "Vintage Sampo solid-state CRT TV, orange",
    shortName: "Sampo CRT TV",
    price: 85,
    condition: "Fair",
    category: "Vintage Electronics",
    pricingStory: "comps",
    details: ["Sampo solid-state CRT set", "Bright orange cabinet", "Dial tuner and side speaker grille"],
    alt: "Retro orange Sampo solid-state CRT television on a wooden shelf",
  },
  {
    slug: "backpack",
    image: "/demo/backpack.jpg",
    title: "Olive everyday daypack with leather patch",
    shortName: "Olive daypack",
    price: 38,
    condition: "Good",
    category: "Bags & Luggage",
    pricingStory: "depreciation",
    details: ["Olive-green everyday daypack", "Tan leather accent patch", "Orange-lined zip pockets"],
    alt: "Worn olive-green everyday daypack on a sunlit wooden bench",
  },
  // --- r6: expanded authentic set (sourced license-clean from Unsplash/Pexels,
  // --- real-seller look) so the carousel + surfaces stay varied and unique ---
  {
    slug: "lamp",
    image: "/demo/lamp.jpg",
    title: "Brass gooseneck desk lamp with dome shade",
    shortName: "Brass desk lamp",
    price: 34,
    condition: "Good",
    category: "Home & Garden",
    pricingStory: "depreciation",
    details: ["Antique-brass finish", "Adjustable gooseneck arm", "Weighted round base"],
    alt: "Brass gooseneck desk lamp lit over an open book on a desk",
  },
  {
    slug: "typewriter",
    image: "/demo/typewriter.jpg",
    title: "Vintage Corona manual typewriter, black",
    shortName: "Corona typewriter",
    price: 145,
    condition: "Fair",
    category: "Vintage Electronics",
    pricingStory: "comps",
    details: ["Corona badge on the body", "Glossy black portable frame", "Round glass-top keys"],
    alt: "Vintage black Corona manual typewriter on a dark rustic wood surface",
  },
  {
    slug: "jacket",
    image: "/demo/jacket.jpg",
    title: "Black moto leather jacket",
    shortName: "Moto jacket",
    price: 42,
    condition: "Good",
    category: "Clothing & Shoes",
    pricingStory: "depreciation",
    details: ["Asymmetric zip moto styling", "Snap collar and zip cuffs", "Worn-in creasing"],
    alt: "Black moto leather jacket on a hanger over dark draped fabric",
  },
  {
    slug: "skillet",
    image: "/demo/skillet.jpg",
    title: "Cast iron skillet with crocheted handle cover",
    shortName: "Cast iron skillet",
    price: 22,
    condition: "Good",
    category: "Home & Kitchen",
    pricingStory: "depreciation",
    details: ["Seasoned cast iron pan", "Knit handle sleeve included", "Honest cooking patina"],
    alt: "Black cast iron skillet with a knit handle cover on a stovetop",
  },
  {
    slug: "plant",
    image: "/demo/plant.jpg",
    title: "Variegated snake plant in a ceramic pot",
    shortName: "Snake plant",
    price: 18,
    condition: "Like new",
    category: "Home & Garden",
    pricingStory: "depreciation",
    details: ["Yellow-edged sansevieria leaves", "Cream glazed ceramic pot", "Healthy upright growth"],
    alt: "Variegated snake plant in a cream ceramic pot on a tiled table",
  },
  {
    slug: "racket",
    image: "/demo/racket.jpg",
    title: "Babolat tennis racket with ball",
    shortName: "Babolat racket",
    price: 60,
    condition: "Good",
    category: "Sporting Goods",
    pricingStory: "comps",
    details: ["Babolat branding on the throat", "Blue and black frame", "Tennis ball included"],
    alt: "Babolat blue and black tennis racket with a ball on a green court",
  },
  {
    slug: "chair",
    image: "/demo/chair.jpg",
    title: "Rolling office task chair",
    shortName: "Office chair",
    price: 25,
    condition: "Fair",
    category: "Furniture",
    pricingStory: "depreciation",
    details: ["Five-star rolling base", "Padded armrests", "Honest wear on the seat"],
    alt: "Worn rolling office task chair in a dim room",
  },
  {
    slug: "boombox",
    image: "/demo/boombox.jpg",
    title: "Vintage Sharp radio cassette boombox, red",
    shortName: "Sharp boombox",
    price: 95,
    condition: "Fair",
    category: "Vintage Electronics",
    pricingStory: "comps",
    details: ["Sharp badge on the front", "Red dual-speaker cassette deck", "Telescopic antennas"],
    alt: "Vintage red Sharp radio cassette boombox on a wooden shelf among plants",
  },
  {
    slug: "watch",
    image: "/demo/watch.jpg",
    title: "Timex chronograph watch, tan leather strap",
    shortName: "Timex chronograph",
    price: 48,
    condition: "Good",
    category: "Watches",
    pricingStory: "comps",
    details: ["Timex dial branding", "Black face with chronograph subdials", "Tan leather strap"],
    alt: "Hand holding a Timex chronograph watch with a tan leather strap",
  },
  {
    slug: "vase",
    image: "/demo/vase.jpg",
    title: "Speckled stoneware ceramic vase",
    shortName: "Ceramic vase",
    price: 28,
    condition: "Good",
    category: "Home & Garden",
    pricingStory: "depreciation",
    details: ["Speckled grey stoneware", "Matte handmade-style glaze", "Single stem vase"],
    alt: "Single speckled grey stoneware vase on a stone shelf in sunlight",
  },
  // r6.1: four authentic used-item photos sourced to break asset reuse across
  // surfaces. The static home/tour spots that used to borrow a video clip's
  // item (three-moves↔step-price, storefront↔step-publish, waterfall↔step-snap)
  // now use these instead, so no product appears on two surfaces.
  // r7: filmcamera is now the how-it-works pipeline's single hero item — it
  // runs through all six step clips (snap → identify → price → write → publish
  // → answer). Its readable "Canon"/"AE-1" markings drive the identify OCR and
  // it has real resale comps for the price step.
  {
    slug: "rollerskates",
    image: "/demo/rollerskates.jpg",
    title: "Denim quad roller skates, light wash blue, women's 8",
    shortName: "Quad roller skates",
    price: 75,
    condition: "Good",
    category: "Sporting Goods",
    pricingStory: "comps",
    details: ["Light-wash denim boot with tan heel", "Cream wheels, lightly worn", "Smooth rolling, no cracks"],
    alt: "A pair of light-blue denim quad roller skates with cream wheels on a concrete ledge against a brick wall",
  },
  {
    slug: "console",
    image: "/demo/console.jpg",
    title: "Nintendo Switch console with neon blue & red Joy-Cons + dock",
    shortName: "Nintendo Switch",
    price: 175,
    condition: "Good",
    category: "Video Games & Consoles",
    pricingStory: "comps",
    details: ["Includes original dock and both neon Joy-Con controllers", "Powers on and works, screen has no cracks", "Light wear from normal home use"],
    alt: "A used Nintendo Switch with neon blue and red Joy-Cons in its dock on a wooden desk",
  },
  {
    slug: "dutchoven",
    image: "/demo/dutchoven.jpg",
    title: "Le Creuset 4.5qt enameled cast iron Dutch oven, Caribbean teal",
    shortName: "Le Creuset Dutch oven",
    price: 185,
    condition: "Good",
    category: "Kitchen & Dining",
    pricingStory: "comps",
    details: ["Enameled cast iron, about 4.5 qt round", "Caribbean teal-blue exterior", "Lightly used, no chips or cracks"],
    alt: "A teal enameled cast iron Dutch oven with its lid on, sitting on a home gas stovetop",
  },
  {
    slug: "filmcamera",
    image: "/demo/filmcamera.jpg",
    title: "Canon AE-1 35mm film SLR camera with 50mm f/1.8 FD lens",
    shortName: "Canon AE-1",
    price: 165,
    condition: "Good",
    category: "Cameras & Photo",
    pricingStory: "comps",
    details: ["Includes Canon FD 50mm lens with front cap and original strap", "Chrome body shows light cosmetic wear, all controls intact", "Classic 1976 manual-focus 35mm film SLR"],
    alt: "A vintage silver and black Canon AE-1 35mm film camera with a 50mm lens and strap on a dark wooden surface at golden hour",
  },
  // r6.1: three more authentic photos so the logged-in dashboard folder stops
  // borrowing the home scan's items (gshock/espresso/turntable). These three
  // are exclusive to the dashboard.
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
];

export const DEMO_PRODUCTS_BY_SLUG: Record<string, DemoProduct> =
  Object.fromEntries(DEMO_PRODUCTS.map((p) => [p.slug, p]));

/**
 * Which surface uses which products. Keeps imagery varied across the app —
 * no product should headline more than one surface.
 */
export const DEMO_SURFACE_ASSIGNMENTS: Record<string, string[]> = {
  // --- Remotion demo-video suite (remotion/suite; see remotion/INTEGRATION.md) ---
  // r7: the how-it-works pipeline now follows ONE item start-to-finish so the
  // narrative holds — the Canon AE-1 (filmcamera) is snapped, identified,
  // priced, written, published, then asked about. Every step clip uses it.
  "hero-video": ["polaroid", "gameboy", "gshock"], // public/hero-demo.mp4 — vision-showcase acts 1–3
  "step-snap": ["filmcamera"], // public/demo/steps/snap.mp4
  "step-identify": ["filmcamera"], // public/demo/steps/identify.mp4
  "step-price": ["filmcamera"], // public/demo/steps/price.mp4
  "step-write": ["filmcamera"], // public/demo/steps/write.mp4
  "step-publish": ["filmcamera"], // public/demo/steps/publish.mp4
  "buyer-qa": ["filmcamera"], // public/demo/buyer-qa.mp4 (tour step 6)
  // r7: the logged-in inbox teaser must show a DIFFERENT item than the tour so
  // a user who already watched the tour gets a fresh scenario, not déjà vu.
  // Brass chess set — hero-domain collectible, disjoint from the AE-1 and from
  // every home surface. Rendered to its own clip (public/demo/inbox-qa.mp4).
  "inbox-qa": ["chess"], // public/demo/inbox-qa.mp4 (logged-in dashboard inbox)
  // --- Static page surfaces (post v3 passes; reflects actual usage) ---
  // r6: a richer 17-card loop, deliberately DISJOINT from the video clips and
  // the scan montage so no image repeats across surfaces. A used tilt (worn
  // boots, dusty drill, vintage typewriter/boombox, frayed chair) because
  // selling secondhand IS the product. book/headphones/chess moved out (they
  // live in the scan montage / buyer-Q&A clip) to keep the loop unique.
  "landing-carousel": [
    "macbook",
    "lamp",
    "boots",
    "typewriter",
    "jacket",
    "bicycle",
    "skillet",
    "drill",
    "plant",
    "crt-tv",
    "racket",
    "chair",
    "skateboard",
    "boombox",
    "watch",
    "vase",
    "backpack",
  ],
  "landing-storefronts": ["console"], // r6.1: was "keyboard"
  // r6.1: the home "From shelf to sold in three moves" prelude — one item shown
  // captured → priced → listed.
  "landing-three-moves": ["rollerskates"],
  // Hero ScanShowcase on the landing page — a deliberate 8-product montage
  // (scanning-beam cycle), exempt from the one-surface rule by design. The
  // eight are picked DISJOINT from the landing carousel and the how-it-works
  // step clips, so no photo repeats across surfaces.
  "landing-hero-scan": [
    "book",
    "vinyl",
    "gameboy",
    "headphones",
    "polaroid",
    "espresso",
    "gshock",
    "turntable",
  ],
  // /features was deleted in r5 (redirects to /how-it-works); the waterfall
  // explorer now lives only on /how-it-works, last section before the CTA.
  "hiw-waterfall": ["dutchoven"], // r6.1: was "guitar"
  "how-it-works": ["gameboy"], // + embeds the step-* clips above
  // r5.1: the upload page's "one photo in, a finished listing out" example
  // strip was removed (how-it-works already tells that story) — gameboy and
  // vinyl remain in use via the step clips and the hiw scan montage.
  // r5: espresso freed up when the About FAQ anchor card was removed; the
  // folder now pops items that no landing surface features.
  // r6.1: was gshock/espresso/turntable, which also headline the home scan.
  // Now three items exclusive to the dashboard (ordered shortest→longest name
  // for the folder's narrow→wide papers).
  "dashboard-folder": ["kettlebell", "binoculars", "sewingmachine"],
};
