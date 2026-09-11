import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "./types";
import { createSyntheticEmbedder, selectEmbedder, syntheticEmbed } from "./embedding";

describe("syntheticEmbed", () => {
  it("returns an all-zero, non-normalized vector for text with no tokens", () => {
    // tokenize() strips anything shorter than 2 chars, so punctuation-only input
    // yields zero tokens. The doc comment on the L2-normalize step promises callers
    // treat cosine similarity with this vector as 0 (the norm===0 branch must skip
    // dividing by zero rather than producing NaNs).
    const vec = syntheticEmbed("... !! ??");

    expect(vec).toHaveLength(EMBEDDING_DIM);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("returns an all-zero vector for empty text", () => {
    const vec = syntheticEmbed("");

    expect(vec).toHaveLength(EMBEDDING_DIM);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("L2-normalizes a non-empty vector so its norm is 1", () => {
    const vec = syntheticEmbed("Sony WH-1000XM4 headphones");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));

    expect(norm).toBeCloseTo(1, 10);
  });
});

describe("createSyntheticEmbedder", () => {
  it("is reported as the synthetic kind with a stable model name", () => {
    const embedder = createSyntheticEmbedder();

    expect(embedder.kind).toBe("synthetic");
    expect(embedder.model).toBe("synthetic-fnv1a-bow");
  });
});

describe("selectEmbedder", () => {
  it("selects the synthetic embedder when no OpenAI key is configured", () => {
    expect(selectEmbedder({}).kind).toBe("synthetic");
  });

  it("selects the synthetic embedder when the key is blank", () => {
    expect(selectEmbedder({ OPENAI_API_KEY: "   " }).kind).toBe("synthetic");
  });

  it("selects the OpenAI embedder when a non-blank key is configured", () => {
    const embedder = selectEmbedder({ OPENAI_API_KEY: "sk-test-key" });

    expect(embedder.kind).toBe("openai");
    expect(embedder.model).toBe("text-embedding-3-small");
  });
});
