import { z } from "zod";

/**
 * RAG (pgvector) contracts — the seeded **reference corpus** (CONTEXT.md: "the
 * seeded set of example items/listings embedded in pgvector, used to ground pricing
 * and few-shot listing generation; avoids cold-start").
 *
 * The corpus is GLOBAL reference data, NOT user-owned. It lives in its own
 * `reference_corpus` table (no `user_id`) — distinct from the per-user `embeddings`
 * table — and is readable by all authenticated users (no public write). See the
 * migration `..._reference_corpus.sql` and README "Reference corpus".
 *
 * Retrieval serves TWO consumers (PRD "RAG (pgvector) — two live jobs"):
 *   (a) a pricing-corroboration signal feeding the confidence composite, and
 *   (b) few-shot examples for the listing generator.
 * This module defines the shapes; `retrieve.ts` implements the query.
 */

/** Embedding dimensionality. Mirrors the `vector(1536)` column (text-embedding-3-small). */
export const EMBEDDING_DIM = 1536;

/**
 * One reference-corpus row as the app sees it. `content` is the good listing copy
 * (the few-shot exemplar); `price` is the corroborating used-price signal.
 */
export const referenceItemSchema = z.object({
  /** Row id (uuid) once persisted. Optional on seed input (DB generates it). */
  id: z.string().optional(),
  /** Stable seed identifier, e.g. "ref-electronics-sony-wh1000xm4". Also the dedupe key. */
  sourceRef: z.string().min(1),
  /** Hero-domain bucket: "books" | "electronics" | "board-games" | "branded-gear" | "generic". */
  category: z.string().min(1),
  /** Brand when known (e.g. "Sony"). Drives query relevance + pricing corroboration. */
  brand: z.string().optional(),
  /** Model when known (e.g. "WH-1000XM4"). */
  model: z.string().optional(),
  /** A realistic used/resale price for this reference item (USD). The corroboration signal. */
  price: z.number().nonnegative(),
  /** Good, platform-competent listing copy — the few-shot exemplar for generation. */
  content: z.string().min(1),
  /** Free-form provenance / extra structured facts (specs, condition, platform). */
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ReferenceItem = z.infer<typeof referenceItemSchema>;

/** A retrieved reference plus its cosine similarity to the query (1 = identical). */
export interface ReferenceMatch extends ReferenceItem {
  /** Cosine similarity in [-1, 1]; higher = closer. Sorted descending by the retriever. */
  similarity: number;
}

/**
 * The text a retrieval query is built from. Mirrors the pricing `ItemSignal` loosely
 * so the pricing and listing slices can call retrieval with what they already hold,
 * without importing each other. At least one field should be present.
 */
export interface RetrievalQuery {
  brand?: string;
  model?: string;
  category?: string;
  /** Free-form text (e.g. resolved product name, title, or a description) to embed. */
  text?: string;
}

/**
 * Consumer (a): pricing corroboration. The retrieved comps' prices summarized into a
 * signal the confidence composite can read WITHOUT this module importing confidence.
 * `priceCount === 0` means "no corroboration found" (an honest low-confidence input).
 */
export interface PricingCorroboration {
  /** The matched references (already similarity-sorted), carrying their prices. */
  matches: ReferenceMatch[];
  /** Count of references that contributed a price. */
  priceCount: number;
  /** Median of matched prices (USD), or null when none. A robust central estimate. */
  medianPrice: number | null;
  /** [min, max] of matched prices, or null when none. */
  priceRange: { min: number; max: number } | null;
  /**
   * Dispersion of matched prices in [0, 1]: 0 = tight cluster (high corroboration),
   * →1 = scattered. Defined as (max-min)/max; null when fewer than 2 priced matches.
   * This is the "comp agreement" raw signal the confidence composite consumes.
   */
  dispersion: number | null;
}

/**
 * Consumer (b): few-shot examples for the listing generator — the retrieved exemplars'
 * good copy, ready to drop into a per-platform generation prompt.
 */
export interface FewShotExamples {
  /** The matched references (already similarity-sorted). */
  matches: ReferenceMatch[];
  /** Just the `content` strings, in match order, for prompt assembly. */
  examples: string[];
}
