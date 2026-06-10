import { EMBEDDING_DIM } from "./types";

/**
 * Pluggable embedding generation for the reference corpus + queries.
 *
 * AGENTS.md: "OpenAI via the Vercel AI SDK. All model calls go through the SDK;
 * provider stays swappable." PRD "Seeded reference corpus from day one" allows a
 * realistic-synthetic corpus disclosed in the README.
 *
 * Two modes, chosen at SEED TIME by whether an OpenAI key is available:
 *  - REAL:      `embedTexts` via the AI SDK's `embedMany` + OpenAI
 *               `text-embedding-3-small` (1536-dim, matching the `vector(1536)` column).
 *  - SYNTHETIC: `syntheticEmbed` — a deterministic, network-free, hashing bag-of-tokens
 *               vector. Shared tokens land on shared dimensions, so semantically similar
 *               text yields higher cosine similarity. This is what makes the retrieval
 *               TEST run OFFLINE and assert ranking deterministically.
 *
 * Both produce L2-normalized 1536-dim vectors, so cosine similarity == dot product and
 * the two modes are interchangeable at the storage/query layer.
 */

export type EmbeddingVector = number[];

/** An embedder: text(s) in, 1536-dim vector(s) out. */
export interface Embedder {
  readonly kind: "openai" | "synthetic";
  readonly model: string;
  embed(texts: string[]): Promise<EmbeddingVector[]>;
}

// ---------------------------------------------------------------------------
// Deterministic synthetic embedder (offline-safe, used by tests + keyless seeds)
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash — small, fast, deterministic. Stable across runs/machines. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (FNV prime), kept in 32-bit unsigned range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Lowercase alphanumeric tokens of length >= 2. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Deterministic bag-of-tokens embedding. Each token contributes a unit-weight bump to
 * two hashed dimensions (reduces collisions vs. a single bucket). The result is
 * L2-normalized so cosine similarity is the dot product. Identical text → identical
 * vector; overlapping tokens → higher similarity; disjoint text → near-orthogonal.
 *
 * Exported so the retrieval test can seed known vectors and assert ranking without a
 * network call. It is NOT a learned model — it's a transparent, reproducible stand-in.
 */
export function syntheticEmbed(
  text: string,
  dim: number = EMBEDDING_DIM,
): EmbeddingVector {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const h1 = fnv1a(tok) % dim;
    const h2 = fnv1a(`${tok}#salt`) % dim;
    // Sign from a third hash so unrelated tokens don't all push the same direction.
    const sign = (fnv1a(`${tok}#sign`) & 1) === 0 ? 1 : -1;
    vec[h1] += sign;
    vec[h2] += sign;
  }
  // L2 normalize (zero vector stays zero — cosine with it is defined as 0 by callers).
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}

/** The offline, deterministic embedder. */
export function createSyntheticEmbedder(): Embedder {
  return {
    kind: "synthetic",
    model: "synthetic-fnv1a-bow",
    embed: async (texts) => texts.map((t) => syntheticEmbed(t)),
  };
}

// ---------------------------------------------------------------------------
// Real OpenAI embedder (via the Vercel AI SDK) — used only when a key is present
// ---------------------------------------------------------------------------

/** OpenAI's small embedding model: 1536 dims, matches the `vector(1536)` column. */
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Real embedder via the AI SDK's `embedMany` + OpenAI. Imported lazily so this module
 * (and the offline test path) never touches the SDK/network unless actually used.
 * `apiKey` defaults to OPENAI_API_KEY in the seed environment.
 */
export function createOpenAIEmbedder(apiKey: string): Embedder {
  return {
    kind: "openai",
    model: OPENAI_EMBEDDING_MODEL,
    embed: async (texts) => {
      const [{ embedMany }, { createOpenAI }] = await Promise.all([
        import("ai"),
        import("@ai-sdk/openai"),
      ]);
      const openai = createOpenAI({ apiKey });
      const { embeddings } = await embedMany({
        model: openai.embedding(OPENAI_EMBEDDING_MODEL),
        values: texts,
      });
      return embeddings;
    },
  };
}

/**
 * Pluggable selection (PRD/AGENTS: provider swappable, env-configurable). Real
 * embeddings when an OpenAI key is set at seed time; deterministic synthetic vectors
 * otherwise. The corpus is disclosed as synthetic in the README when the synthetic
 * path produced it.
 */
export function selectEmbedder(env: {
  OPENAI_API_KEY?: string;
}): Embedder {
  const key = env.OPENAI_API_KEY?.trim();
  return key ? createOpenAIEmbedder(key) : createSyntheticEmbedder();
}
