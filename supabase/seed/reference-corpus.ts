/**
 * Seed the global **reference corpus** into pgvector (PRD "Seeded reference corpus
 * from day one"). Idempotent, run with the SERVICE ROLE (which bypasses RLS — the
 * corpus has a read-only RLS policy and no write policy for app roles).
 *
 * Embeddings are PLUGGABLE (AGENTS.md "provider stays swappable"):
 *   - real OpenAI `text-embedding-3-small` vectors when OPENAI_API_KEY is set, else
 *   - deterministic SYNTHETIC vectors (disclosed as such in the README).
 *
 * Why not the `embeddings` table? That table is PER-USER (user_id + RLS). The reference
 * corpus is GLOBAL platform data, so it lives in its own `reference_corpus` table.
 *
 * Usage (env via `.env.local` or `pnpm supabase status -o env`):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     pnpm exec tsx supabase/seed/reference-corpus.ts
 * (also set OPENAI_API_KEY to seed real embeddings).
 *
 * It UPSERTs on `source_ref`, so re-running refreshes content/prices/embeddings without
 * duplicating rows, and only touches `reference_corpus` (safe on a shared DB).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type Embedder, selectEmbedder } from "../../src/lib/rag/embedding";
import {
  REFERENCE_CORPUS,
  corpusEmbeddingText,
} from "../../src/lib/rag/corpus-data";
import { type ReferenceItem } from "../../src/lib/rag/types";

/** A reference-corpus row in the DB's snake_case shape (embedding as a pgvector literal). */
export interface SeedRow {
  source_ref: string;
  category: string;
  brand: string | null;
  model: string | null;
  price: number;
  content: string;
  metadata: Record<string, unknown>;
  embedding_model: string;
  embedding: string;
}

/** Pure: pair each corpus item with its embedding into the DB row shape. */
export function buildSeedRows(
  items: ReferenceItem[],
  vectors: number[][],
  embeddingModel: string,
): SeedRow[] {
  return items.map((item, i) => ({
    source_ref: item.sourceRef,
    category: item.category,
    brand: item.brand ?? null,
    model: item.model ?? null,
    price: item.price,
    content: item.content,
    metadata: item.metadata,
    embedding_model: embeddingModel,
    embedding: `[${vectors[i].join(",")}]`,
  }));
}

/**
 * Embed the corpus with `embedder` and UPSERT it into `reference_corpus` via the given
 * (service-role) client. Returns the rows written. Reusable from the CLI and tests.
 */
export async function seedReferenceCorpus(
  client: SupabaseClient,
  embedder: Embedder,
  items: ReferenceItem[] = REFERENCE_CORPUS,
): Promise<SeedRow[]> {
  const vectors = await embedder.embed(items.map(corpusEmbeddingText));
  const rows = buildSeedRows(items, vectors, embedder.model);
  const { error } = await client
    .from("reference_corpus")
    .upsert(rows, { onConflict: "source_ref" });
  if (error) throw new Error(`[seed] upsert failed: ${error.message}`);
  return rows;
}

async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Seed requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and " +
        "SUPABASE_SERVICE_ROLE_KEY. Get them from `pnpm supabase status -o env`.",
    );
  }

  const embedder = selectEmbedder({ OPENAI_API_KEY: process.env.OPENAI_API_KEY });
  console.log(
    `[seed] embedder=${embedder.kind} (${embedder.model}) — ` +
      (embedder.kind === "openai"
        ? "real OpenAI embeddings"
        : "SYNTHETIC embeddings (no OPENAI_API_KEY; disclosed in README)"),
  );

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rows = await seedReferenceCorpus(admin, embedder);
  const { count, error: countErr } = await admin
    .from("reference_corpus")
    .select("*", { count: "exact", head: true });
  if (countErr) console.warn(`[seed] corpus count query failed: ${countErr.message}`);
  const sizeStr = countErr || count == null ? "unknown" : String(count);
  console.log(
    `[seed] upserted ${rows.length} reference rows. Corpus size now: ${sizeStr}.`,
  );
}

// Run as a script (not when imported by a test). import.meta.main is set by tsx/node
// when this file is the entrypoint; the `endsWith` fallback covers plain `node` runs.
const isEntrypoint =
  // @ts-expect-error import.meta.main is available in modern runtimes/tsx.
  import.meta.main ?? process.argv[1]?.endsWith("reference-corpus.ts");
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
