/**
 * RAG (pgvector) — public surface for the reference-corpus retrieval slice.
 *
 * Consumers:
 *  - Pricing slice → `retrieveReferences` + `pricingCorroboration` (a corroborating
 *    used-price signal feeding the confidence composite).
 *  - Listing generator → `retrieveReferences` + `fewShotExamples` (good copy exemplars).
 *
 * Embedding is pluggable (`selectEmbedder`): real OpenAI vectors when a key is present,
 * deterministic synthetic vectors otherwise. The embedder used at query time MUST match
 * the one the corpus was seeded with.
 */
export {
  type EmbeddingVector,
  type Embedder,
  selectEmbedder,
  createSyntheticEmbedder,
  createOpenAIEmbedder,
  syntheticEmbed,
  OPENAI_EMBEDDING_MODEL,
} from "./embedding";

export {
  retrieveReferences,
  pricingCorroboration,
  fewShotExamples,
  rankBySimilarity,
  cosineSimilarity,
  queryText,
  type RetrieveOptions,
} from "./retrieve";

export {
  EMBEDDING_DIM,
  referenceItemSchema,
  type ReferenceItem,
  type ReferenceMatch,
  type RetrievalQuery,
  type PricingCorroboration,
  type FewShotExamples,
} from "./types";

export { REFERENCE_CORPUS, corpusEmbeddingText } from "./corpus-data";
