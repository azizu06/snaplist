import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type EmbeddingVector,
  type Embedder,
  syntheticEmbed,
} from "./embedding";
import {
  type FewShotExamples,
  type PricingCorroboration,
  type ReferenceItem,
  type ReferenceMatch,
  type RetrievalQuery,
} from "./types";

/**
 * Reference-corpus retrieval (PRD "RAG (pgvector) — two live jobs"). Serves both
 * consumers from one similarity query:
 *   (a) `pricingCorroboration` — a corroborating price signal feeding confidence;
 *   (b) `fewShotExamples` — good listing copy to few-shot the listing generator.
 *
 * Layering, so the ranking/shaping logic is testable OFFLINE (no network):
 *  - `cosineSimilarity` / `rankBySimilarity` — pure functions over vectors.
 *  - `pricingCorroboration` / `fewShotExamples` — pure shaping over matches.
 *  - `retrieveReferences` — the DB-backed query (calls the `match_reference_corpus`
 *    RPC defined in the reference_corpus migration). Integration-tested behind a
 *    "skip if the local stack is unreachable" gate, never faking a pass.
 */

/** The query text we embed: brand/model/category + free text, matching seed text shape. */
export function queryText(q: RetrievalQuery): string {
  return [q.brand, q.model, q.category, q.text].filter(Boolean).join(" ").trim();
}

/** Cosine similarity of two equal-length vectors. Returns 0 if either is a zero vector. */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pure in-memory ranking: score each candidate against the query vector by cosine
 * similarity, sort descending, and take the top `k`. Mirrors what the DB RPC does
 * (the migration uses `vector_cosine_ops`), so the offline test asserts the exact
 * ranking the live query would produce.
 */
export function rankBySimilarity(
  queryVec: EmbeddingVector,
  candidates: Array<{ item: ReferenceItem; embedding: EmbeddingVector }>,
  k: number,
): ReferenceMatch[] {
  return candidates
    .map(({ item, embedding }) => ({
      ...item,
      similarity: cosineSimilarity(queryVec, embedding),
    }))
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, k);
}

export interface RetrieveOptions {
  /** Max matches to return. Default 5 (a sensible few-shot count). */
  matchCount?: number;
  /** Optional category filter (e.g. only "electronics"). */
  category?: string;
  /**
   * Floor on cosine similarity; matches below it are dropped. Default 0 keeps all
   * (callers that want "no corroboration" honesty can raise it).
   */
  minSimilarity?: number;
}

/** Shape of a row returned by the `match_reference_corpus` RPC. */
interface MatchRow {
  id: string;
  source_ref: string;
  category: string;
  brand: string | null;
  model: string | null;
  price: number | string;
  content: string;
  metadata: Record<string, unknown> | null;
  similarity: number;
}

function rowToMatch(row: MatchRow): ReferenceMatch {
  return {
    id: row.id,
    sourceRef: row.source_ref,
    category: row.category,
    brand: row.brand ?? undefined,
    model: row.model ?? undefined,
    price: typeof row.price === "string" ? Number(row.price) : row.price,
    content: row.content,
    metadata: row.metadata ?? {},
    similarity: row.similarity,
  };
}

/**
 * Retrieve the most similar reference-corpus rows for an item query.
 *
 * Embeds the query (real OpenAI embedder when seeded that way, else the deterministic
 * synthetic embedder — the embedder MUST match the one the corpus was seeded with so
 * the vector spaces align) and runs the `match_reference_corpus` pgvector RPC.
 *
 * `client` may be the service-role or the per-user server client; the corpus is global
 * read-only reference data so either works (RLS allows SELECT to all authenticated).
 */
export async function retrieveReferences(
  client: SupabaseClient,
  query: RetrievalQuery,
  embedder: Embedder,
  opts: RetrieveOptions = {},
): Promise<ReferenceMatch[]> {
  const text = queryText(query);
  if (!text) return [];

  const matchCount = opts.matchCount ?? 5;
  const minSimilarity = opts.minSimilarity ?? 0;

  const [embedding] = await embedder.embed([text]);
  // pgvector accepts a bracketed string literal for the vector parameter.
  const vectorLiteral = `[${embedding.join(",")}]`;

  const { data, error } = await client.rpc("match_reference_corpus", {
    query_embedding: vectorLiteral,
    match_count: matchCount,
    filter_category: opts.category ?? null,
  });
  if (error) {
    throw new Error(`match_reference_corpus RPC failed: ${error.message}`);
  }

  return (data as MatchRow[])
    .map(rowToMatch)
    .filter((m) => m.similarity >= minSimilarity);
}

// ---------------------------------------------------------------------------
// Consumer (a): pricing corroboration — a confidence-bearing signal (pure)
// ---------------------------------------------------------------------------

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Summarize matches into a pricing-corroboration signal for the confidence composite.
 * Pure: matches in, signal out. `priceCount === 0` (e.g. nothing retrieved) is the
 * honest "no corroboration" case the confidence step should treat as low.
 */
export function pricingCorroboration(
  matches: ReferenceMatch[],
): PricingCorroboration {
  const prices = matches
    .map((m) => m.price)
    .filter((p): p is number => typeof p === "number" && p > 0);

  if (prices.length === 0) {
    return {
      matches,
      priceCount: 0,
      medianPrice: null,
      priceRange: null,
      dispersion: null,
    };
  }

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    matches,
    priceCount: prices.length,
    medianPrice: median(prices),
    priceRange: { min, max },
    // (max-min)/max ∈ [0,1): tight cluster → ~0 (high agreement), scattered → →1.
    dispersion: prices.length >= 2 && max > 0 ? (max - min) / max : null,
  };
}

// ---------------------------------------------------------------------------
// Consumer (b): few-shot examples for listing generation (pure)
// ---------------------------------------------------------------------------

/**
 * Shape matches into few-shot exemplars for the listing generator. Pure: matches in,
 * their good copy out, in similarity order, ready to drop into a generation prompt.
 */
export function fewShotExamples(matches: ReferenceMatch[]): FewShotExamples {
  return {
    matches,
    examples: matches.map((m) => m.content),
  };
}

/** Re-export so consumers can build a query vector without importing embedding.ts. */
export { syntheticEmbed };
