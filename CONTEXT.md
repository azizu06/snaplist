# SnapList — Domain Context & Glossary

The shared vocabulary for this repo. Use these exact terms in code, issues, tests, and PRDs. Full
requirements live in `PRD.md`; this file is the language layer the engineering skills read first.

## What the product does (one paragraph)
A seller photographs a used item; SnapList **identifies** it, **prices** it with a cited range and a
**confidence** score, **generates** platform-specific listing copy, and (later) **drafts** buyer
replies. The seller reviews/approves; high-confidence items may post on **autopilot**. Listings post
to eBay (behind an **adapter**) and produce **export packs** for other platforms.

## Glossary (ubiquitous language)

- **Item** — a single physical thing the seller wants to sell. The root entity. Has photos, extracted
  **attributes**, a **condition**, and (once priced) a **price recommendation**.
- **Attributes** — the structured, Zod-validated facts extracted from photos: brand, model, category,
  key specs, and any decoded **barcode**/**ISBN**. Prefer "attributes" over "metadata" or "details".
- **Condition** — the assessed wear state of a used item (e.g. new/like-new/good/fair). A first-class
  attribute because it drives pricing. Not "quality".
- **Barcode / ISBN / UPC** — *ISBN* (books/media) resolves to a true structured price lookup. *UPC*
  (general goods) is decoded only as an **identification aid** that sharpens the search, never a price
  source. "Barcode" is the umbrella term.
- **PricingProvider** — the interface every pricing strategy implements. Returns a **price
  recommendation**. Never bypass it with an inline price lookup.
- **Tier** — one PricingProvider strategy in the routing pipeline: *ISBN lookup* → *web-search agent*
  → *depreciation estimate* → *LLM fallback*. "Which tier fired" is a logged, confidence-bearing fact.
- **Pricing (research) agent** — the bounded tool-calling **agent** that searches the web for
  used/resale comps and synthesizes a cited range. One of two agents in the system.
- **Comp** — a comparable price point found for an item. **Comp agreement** (tight vs scattered) is a
  confidence signal. Open-web comps are usually *asking* prices, not *sold* prices — down-weight
  accordingly.
- **Price recommendation** — always `{ suggested, range, confidence, sources[] }`, always
  user-editable. Never a bare number.
- **Confidence (composite)** — a signal-based score from {tier fired, comp agreement, identification
  completeness}. Never raw LLM self-report. Drives the **autopilot gate**.
- **Autopilot** — the confidence-gated posting behavior: high-confidence items are eligible to post
  automatically; low-confidence items **queue for review**. Toggleable off.
- **Listing** — generated, platform-specific sale copy for an item (title, item specifics,
  description, tags). One **Item** can have multiple listings (one per platform).
- **Export pack** — copy-paste listing text for a platform with no write API (Facebook Marketplace,
  Mercari). Distinct from a real **post**.
- **Post / publish** — actually putting a listing live on eBay via the **adapter**.
- **Adapter** — the isolating interface around eBay (posting + messaging). The pipeline must run and
  be testable against a **mock adapter** with no live eBay. Sandbox→production is a credential flip.
- **Buyer-Q&A agent** — the **agent** that drafts replies to buyer questions, grounded in an item's
  attributes/listing. v1: runs on **simulated** messages; final: wired to real eBay messaging.
- **Inbox** — the seller's live view of buyer **messages**, fed DB→Supabase Realtime. The seller is
  the only SnapList user; buyers stay on eBay.
- **Reference corpus** — the seeded set of example items/listings embedded in **pgvector**, used to
  ground pricing and few-shot listing generation (avoids cold-start).
- **Prediction log** — the per-run record (attributes, price, range, confidence, tier, model) written
  for every pipeline execution. The **eval harness** depends on it.
- **Eval harness** — the offline quality measurement over a fixed **gold set**: ID accuracy,
  pricing-within-band, **confidence calibration**, listing quality (validated LLM-judge).
- **Gold set** — the fixed, labeled set of items used by the eval harness; doubles as the demo set.
- **Hero domain** — the item categories SnapList excels at (books/media, electronics, board games,
  branded gear). Generic items still flow through but honestly show low confidence.

## Terms to avoid
- "metadata" → use **attributes**. "quality" (of an item) → use **condition**. "the model's
  confidence" when meaning self-report → say so explicitly; default **confidence** means the composite.
- "chat" / "conversation platform" → SnapList is a seller **control surface**, not a chat app.

## Actors
- **Seller** — the SnapList user. The only human in the app.
- **Buyer** — a person on eBay asking questions. Never a SnapList user.
- **Builder** — Aziz, operating the project as a portfolio/showcase (eval, architecture, narrative).
