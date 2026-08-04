import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cosineSimilarity,
  fewShotExamples,
  pricingCorroboration,
  queryText,
  rankBySimilarity,
  retrieveReferences,
} from "./retrieve";
import {
  createSyntheticEmbedder,
  syntheticEmbed,
} from "./embedding";
import { REFERENCE_CORPUS, corpusEmbeddingText } from "./corpus-data";
import { EMBEDDING_DIM, type ReferenceItem } from "./types";
import { seedReferenceCorpus } from "../../../supabase/seed/reference-corpus";
import { stackReachable } from "@/test/supabase-stack";

/**
 * Reference-corpus retrieval tests.
 *
 * The CORE tests run fully OFFLINE (no network): they use the deterministic synthetic
 * embedder over the real seed corpus and assert the similarity RANKING and both
 * consumer shapes deterministically. This is the contract that lets the pricing and
 * listing slices trust retrieval without a live model or DB.
 *
 * A second block is an integration test that seeds the real `reference_corpus` table
 * and exercises the `match_reference_corpus` RPC — it SKIPS (never fakes a pass) when
 * the local Supabase stack is unreachable, mirroring `src/lib/supabase/rls.test.ts`.
 */

// ---------------------------------------------------------------------------
// OFFLINE: deterministic vectors → expected ranking + consumer shapes
// ---------------------------------------------------------------------------

describe("rag/embedding (synthetic, deterministic)", () => {
  it("produces 1536-dim, L2-normalized, reproducible vectors", () => {
    const a = syntheticEmbed("Sony WH-1000XM4 wireless noise cancelling headphones");
    const b = syntheticEmbed("Sony WH-1000XM4 wireless noise cancelling headphones");
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(a).toEqual(b); // identical text → identical vector
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("scores identical text as ~1 and unrelated text as low cosine similarity", () => {
    const headphones = syntheticEmbed("Sony noise cancelling headphones bluetooth");
    const same = syntheticEmbed("Sony noise cancelling headphones bluetooth");
    const book = syntheticEmbed("Clean Code paperback software craftsmanship Robert Martin");

    expect(cosineSimilarity(headphones, same)).toBeCloseTo(1, 6);
    // Disjoint vocabulary → near-orthogonal (well below the self-match).
    expect(cosineSimilarity(headphones, book)).toBeLessThan(0.3);
  });
});

describe("rag/retrieve.rankBySimilarity (offline, over the real corpus)", () => {
  const embedder = createSyntheticEmbedder();

  // Pre-embed the corpus once (what the seed step persists to pgvector).
  let candidates: Array<{ item: ReferenceItem; embedding: number[] }>;

  beforeAll(() => {
    candidates = REFERENCE_CORPUS.map((item) => ({
      item,
      embedding: syntheticEmbed(corpusEmbeddingText(item)),
    }));
  });

  it("ranks the obviously-matching reference first for an electronics query", async () => {
    const [queryVec] = await embedder.embed([
      queryText({ brand: "Sony", model: "WH-1000XM4", category: "electronics" }),
    ]);
    const ranked = rankBySimilarity(queryVec, candidates, 5);

    expect(ranked[0].sourceRef).toBe("ref-electronics-sony-wh1000xm4");
    // Similarity is monotonically non-increasing (sorted descending).
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].similarity).toBeGreaterThanOrEqual(ranked[i].similarity);
    }
    // The top hit is in the same hero category as the query.
    expect(ranked[0].category).toBe("electronics");
  });

  it("ranks a book reference first for an ISBN/book query, not an electronics one", async () => {
    const [queryVec] = await embedder.embed([
      queryText({
        brand: "Prentice Hall",
        model: "Clean Code",
        category: "books",
        text: "software craftsmanship paperback",
      }),
    ]);
    const ranked = rankBySimilarity(queryVec, candidates, 3);

    expect(ranked[0].sourceRef).toBe("ref-books-clean-code");
    expect(ranked[0].category).toBe("books");
    // An electronics reference must not outrank the matching book.
    const topElectronics = ranked.find((m) => m.category === "electronics");
    if (topElectronics) {
      expect(ranked[0].similarity).toBeGreaterThan(topElectronics.similarity);
    }
  });

  it("respects the top-k cap", async () => {
    const [queryVec] = await embedder.embed([queryText({ category: "board-games" })]);
    expect(rankBySimilarity(queryVec, candidates, 2)).toHaveLength(2);
    expect(rankBySimilarity(queryVec, candidates, 4)).toHaveLength(4);
  });
});

describe("rag pricing corroboration (consumer a, pure)", () => {
  it("summarizes matched prices into median / range / dispersion", () => {
    const matches = [
      { sourceRef: "x", category: "electronics", price: 100, content: "a", metadata: {}, similarity: 0.9 },
      { sourceRef: "y", category: "electronics", price: 120, content: "b", metadata: {}, similarity: 0.8 },
      { sourceRef: "z", category: "electronics", price: 110, content: "c", metadata: {}, similarity: 0.7 },
    ];
    const c = pricingCorroboration(matches);
    expect(c.priceCount).toBe(3);
    expect(c.medianPrice).toBe(110);
    expect(c.priceRange).toEqual({ min: 100, max: 120 });
    // (120-100)/120 ≈ 0.1667 — a tight cluster → high agreement.
    expect(c.dispersion).toBeCloseTo(0.1667, 3);
  });

  it("a tight price cluster has lower dispersion than a scattered one", () => {
    const tight = pricingCorroboration([
      { sourceRef: "a", category: "c", price: 98, content: "x", metadata: {}, similarity: 1 },
      { sourceRef: "b", category: "c", price: 102, content: "x", metadata: {}, similarity: 1 },
    ]);
    const scattered = pricingCorroboration([
      { sourceRef: "a", category: "c", price: 20, content: "x", metadata: {}, similarity: 1 },
      { sourceRef: "b", category: "c", price: 200, content: "x", metadata: {}, similarity: 1 },
    ]);
    expect(tight.dispersion!).toBeLessThan(scattered.dispersion!);
  });

  it("honestly reports no corroboration when there are no matches", () => {
    const c = pricingCorroboration([]);
    expect(c.priceCount).toBe(0);
    expect(c.medianPrice).toBeNull();
    expect(c.priceRange).toBeNull();
    expect(c.dispersion).toBeNull();
  });

  it("excludes below-floor (unrelated) matches from the price signal", () => {
    const matches = [
      { sourceRef: "a", category: "c", price: 100, content: "x", metadata: {}, similarity: 0.05 },
      { sourceRef: "b", category: "c", price: 9999, content: "y", metadata: {}, similarity: 0.02 },
    ];
    // Both are well below the relevance floor → honest "no corroboration", not a
    // fabricated median from arbitrary products.
    const c = pricingCorroboration(matches);
    expect(c.priceCount).toBe(0);
    expect(c.medianPrice).toBeNull();
  });
});

describe("rag few-shot examples (consumer b, pure)", () => {
  it("returns the good listing copy in match order", () => {
    const matches = [
      { sourceRef: "a", category: "c", price: 1, content: "FIRST copy", metadata: {}, similarity: 0.9 },
      { sourceRef: "b", category: "c", price: 1, content: "SECOND copy", metadata: {}, similarity: 0.5 },
    ];
    const f = fewShotExamples(matches);
    expect(f.examples).toEqual(["FIRST copy", "SECOND copy"]);
    expect(f.matches).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: real pgvector RPC against the local stack (skips if unreachable)
// ---------------------------------------------------------------------------

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!(await stackReachable({
  url: SUPABASE_URL,
  apiKey: ANON_KEY,
  requiredValues: [ANON_KEY, SERVICE_ROLE_KEY],
})))("rag/retrieve against pgvector", () => {
  let admin: SupabaseClient;
  const embedder = createSyntheticEmbedder();
  // Namespaced so we only touch + clean up OUR rows on a shared DB.
  const TEST_PREFIX = `test-rag-${Date.now()}-`;
  const seededRefs: string[] = [];

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Seed a small, known set of OUR rows via the REAL seed function (service role
    // bypasses RLS for writes). Namespaced source_refs so we only clean up our rows.
    const subset: ReferenceItem[] = REFERENCE_CORPUS.slice(0, 6).map((item) => ({
      ...item,
      sourceRef: `${TEST_PREFIX}${item.sourceRef}`,
    }));
    const written = await seedReferenceCorpus(admin, embedder, subset);
    seededRefs.push(...written.map((r) => r.source_ref));
  });

  afterAll(async () => {
    await admin.from("reference_corpus").delete().in("source_ref", seededRefs);
  });

  it("match_reference_corpus returns OUR most-similar seeded reference first", async () => {
    const matches = await retrieveReferences(
      admin,
      { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
      embedder,
      { matchCount: 5 },
    );
    const ours = matches.filter((m) => m.sourceRef.startsWith(TEST_PREFIX));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours[0].sourceRef).toBe(`${TEST_PREFIX}ref-electronics-sony-wh1000xm4`);
    // A real semantic match: query shares brand/model/category tokens with the seed
    // (diluted by the longer copy), so well above an unrelated reference but not ~1.
    expect(ours[0].similarity).toBeGreaterThan(0.25);
    // Sorted descending by similarity.
    for (let i = 1; i < ours.length; i++) {
      expect(ours[i - 1].similarity).toBeGreaterThanOrEqual(ours[i].similarity);
    }
    // The top hit clearly outranks any non-electronics reference (book/board-game).
    const offDomain = ours.find((m) => m.category !== "electronics");
    if (offDomain) {
      expect(ours[0].similarity).toBeGreaterThan(offDomain.similarity);
    }
  });

  it("the anon (authenticated-tier) role can READ the global corpus (RLS allows select)", async () => {
    const anon = createClient(SUPABASE_URL, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Note: `anon` role here. The migration grants SELECT to BOTH `authenticated` and
    // `anon` (global reference data is open to read), so this read is allowed; the
    // security property we assert is that a NON-service client cannot WRITE (below).
    const { error } = await anon.rpc("match_reference_corpus", {
      query_embedding: `[${syntheticEmbed("Sony headphones").join(",")}]`,
      match_count: 3,
      filter_category: null,
    });
    expect(error).toBeNull();
  });

  it("a non-service client CANNOT write to the global corpus (no write policy)", async () => {
    const anon = createClient(SUPABASE_URL, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await anon
      .from("reference_corpus")
      .insert({
        source_ref: `${TEST_PREFIX}should-not-insert`,
        category: "generic",
        price: 1,
        content: "blocked",
        embedding: `[${syntheticEmbed("blocked").join(",")}]`,
      })
      .select();
    // RLS with no INSERT policy → write denied (error or zero rows, never persisted).
    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();
  });
});
