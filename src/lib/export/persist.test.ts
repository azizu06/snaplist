import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedAttributes } from "../pipeline/types";
import {
  DEPOP_PLATFORM,
  FACEBOOK_PLATFORM,
  MERCARI_PLATFORM,
  type RawExportPacks,
} from "./schema";
import type { ExportPackGenerate } from "./generate";
import { loadOrGenerateExportPacks } from "./persist";

/**
 * Load-or-generate seam tests (issue #15). Fully OFFLINE: a minimal fake
 * Supabase client (just the query-builder surface this helper touches) plus an
 * injected fake model call. Asserts the seam behavior:
 *
 *  - first visit: generates and persists one draft row per platform through the
 *    revision-guarded RPC, then returns the fresh packs;
 *  - later visits at the same content revision reuse persisted model copy with no
 *    model call while the full review revision keeps the effective price current;
 *  - invalid, partial, or obsolete-revision rows regenerate without duplicating
 *    a valid platform row for the active revision.
 */

interface InsertedRow {
  platform: string;
  title: string;
  description: string;
  copy: Record<string, unknown>;
}

interface StoredRow {
  platform: string;
  title: string | null;
  description: string | null;
  copy: Record<string, unknown> | null;
}

interface FakeSupabaseOptions {
  currentReviewRevision?: () => string;
  afterPersist?: () => void;
}

function fakeSupabase(
  rows: StoredRow[],
  inserted: InsertedRow[],
  persistedRevisions: string[] = [],
  persistError: { message: string } | null = null,
  options: FakeSupabaseOptions = {},
): SupabaseClient {
  const filters = {
    eq: () => filters,
    in: () => ({
      order: async () => ({ data: rows, error: null }),
    }),
  };
  return {
    from(table: string) {
      if (table === "listings") {
        return {
          select: () => filters,
        };
      }
      if (table === "items") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  review_revision:
                    options.currentReviewRevision?.() ?? REVIEW_REVISION,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "persist_export_packs") throw new Error(`unexpected rpc ${name}`);
      const currentReviewRevision =
        options.currentReviewRevision?.() ?? REVIEW_REVISION;
      if (args.p_expected_review_revision !== currentReviewRevision) {
        return {
          error: { message: "Seller price changed. Reload and try again." },
        };
      }
      inserted.push(...(args.p_packs as InsertedRow[]));
      persistedRevisions.push(args.p_source_review_revision as string);
      options.afterPersist?.();
      return { error: persistError };
    },
  } as unknown as SupabaseClient;
}

const CORE: ExtractedAttributes = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  // The vision-validated display title grounds the word "headphones" — the
  // title guard (round 5) rejects any title token outside the core.
  title: "Sony WH-1000XM4 Headphones",
};

const RAW: RawExportPacks = {
  facebook: {
    title: "Sony WH-1000XM4 headphones",
    description: "Selling my Sony headphones, good condition. Work great.",
  },
  mercari: {
    title: "Sony WH-1000XM4 Headphones",
    description: "Sony WH-1000XM4 in good condition. Ships next day.",
    hashtags: ["#sony", "#electronics"],
  },
};

const REVIEW_REVISION = "00000000-0000-4000-8000-000000000001";

/**
 * A valid persisted Depop row (issue #378). Depop is the third honest
 * destination, so a store is only "complete" when it carries one too — tests
 * that assert the fully-cached path must include it.
 */
function storedDepopRow(): StoredRow {
  return {
    platform: DEPOP_PLATFORM,
    // Row identity only; Depop has no title field and the block never shows it.
    title: "Sony WH-1000XM4",
    description: "Sony WH-1000XM4. Condition: good.",
    copy: {
      hashtags: ["#sony"],
      copyBlock: "Sony WH-1000XM4. Condition: good.\n\n#sony",
    },
  };
}

function countingGenerate(): { generate: ExportPackGenerate; calls: () => number } {
  let n = 0;
  return {
    generate: async () => {
      n += 1;
      return RAW;
    },
    calls: () => n,
  };
}

describe("loadOrGenerateExportPacks", () => {
  it("gives every platform pack the seller override instead of the latest AI suggestion", async () => {
    const inserted: InsertedRow[] = [];
    const { generate } = countingGenerate();

    const view = await loadOrGenerateExportPacks(fakeSupabase([], inserted), {
      userId: "user-1",
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewContentRevision: REVIEW_REVISION,
      attributes: CORE,
      suggestedPrice: 44.44,
      priceOverride: 177.77,
      generate,
      model: "test-model",
    });

    expect(view.facebook.price).toBe(177.77);
    expect(view.mercari.price).toBe(177.77);
    expect(view.depop.price).toBe(177.77);
    expect(view.facebook.copyBlock).toContain("Asking $177.77");
    expect(inserted).toHaveLength(3);
    for (const row of inserted) {
      expect(row.copy["price"]).toBe(177.77);
    }
  });

  it.each([
    { label: "missing", priceOverride: null },
    { label: "invalid", priceOverride: "not-a-price" },
  ])(
    "gives every platform pack the latest AI suggestion for a $label override",
    async ({ priceOverride }) => {
      const inserted: InsertedRow[] = [];
      const { generate } = countingGenerate();

      const view = await loadOrGenerateExportPacks(fakeSupabase([], inserted), {
        userId: "user-1",
        itemId: "item-1",
        reviewRevision: REVIEW_REVISION,
        reviewContentRevision: REVIEW_REVISION,
        attributes: CORE,
        suggestedPrice: 44.44,
        priceOverride,
        generate,
        model: "test-model",
      });

      expect(view.facebook.price).toBe(44.44);
      expect(view.mercari.price).toBe(44.44);
      expect(view.depop.price).toBe(44.44);
      for (const row of inserted) {
        expect(row.copy["price"]).toBe(44.44);
      }
    },
  );

  it("first visit: generates, persists a draft row per platform, returns fresh packs", async () => {
    const inserted: InsertedRow[] = [];
    const persistedRevisions: string[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(
      fakeSupabase([], inserted, persistedRevisions),
      {
        userId: "user-1",
        itemId: "item-1",
        reviewRevision: REVIEW_REVISION,
        reviewContentRevision: REVIEW_REVISION,
        attributes: CORE,
        suggestedPrice: 120,
        generate,
        model: "test-model",
      },
    );

    expect(calls()).toBe(1);
    expect(view.cached).toBe(false);
    expect(view.model).toBe("test-model");
    expect(view.facebook.copyBlock).toContain("Asking $120");
    expect(view.mercari.hashtags.length).toBeGreaterThan(0);

    expect(inserted).toHaveLength(3);
    expect(persistedRevisions).toEqual([REVIEW_REVISION]);
    const platforms = inserted.map((r) => r.platform).sort();
    expect(platforms).toEqual([DEPOP_PLATFORM, FACEBOOK_PLATFORM, MERCARI_PLATFORM]);
    for (const row of inserted) {
      expect(typeof row.copy["copyBlock"]).toBe("string");
      // Provenance is persisted WITH the pack so export outputs stay
      // attributable on later cached reads (AGENTS.md: log every run's model).
      expect(row.copy["model"]).toBe("test-model");
    }
  });

  it("cached reads return the PERSISTED model provenance, not undefined", async () => {
    const stored: StoredRow[] = [
      {
        platform: FACEBOOK_PLATFORM,
        title: "Stored FB title",
        description: "Stored FB description.",
        copy: {
          copyBlock: "Stored FB title\n\nStored FB description.",
          model: "stored-model-id",
        },
      },
      {
        platform: MERCARI_PLATFORM,
        title: "Stored Mercari title",
        description: "Stored Mercari description. Ships fast.",
        copy: {
          hashtags: ["#sony"],
          copyBlock: "Stored Mercari title\n\nStored Mercari description.\n\n#sony",
          model: "stored-model-id",
        },
      },
      storedDepopRow(),
    ];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, []), {
      userId: "user-1",
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewContentRevision: REVIEW_REVISION,
      attributes: CORE,
      generate,
    });
    expect(calls()).toBe(0);
    expect(view.cached).toBe(true);
    expect(view.model).toBe("stored-model-id");
  });

  it("later visits: serves both packs from the stored rows with NO model call", async () => {
    const stored: StoredRow[] = [
      {
        platform: FACEBOOK_PLATFORM,
        title: "Stored FB title",
        description: "Stored FB description.",
        copy: { copyBlock: "Stored FB title\n\nStored FB description." },
      },
      {
        platform: MERCARI_PLATFORM,
        title: "Stored Mercari title",
        description: "Stored Mercari description. Ships fast.",
        copy: {
          hashtags: ["#sony"],
          copyBlock: "Stored Mercari title\n\nStored Mercari description. Ships fast.\n\n#sony",
        },
      },
      storedDepopRow(),
    ];
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, inserted), {
      userId: "user-1",
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewContentRevision: REVIEW_REVISION,
      attributes: CORE,
      generate,
    });

    expect(calls()).toBe(0);
    expect(view.cached).toBe(true);
    expect(view.facebook.title).toBe("Stored FB title");
    expect(view.mercari.hashtags).toEqual(["#sony"]);
    expect(inserted).toHaveLength(0);
  });

  it("cached packs use the CURRENT seller override, never the persisted price snapshot", async () => {
    // The pack was generated at 100; a new AI run says 120, but the seller has
    // approved 177.77. Both cached platform packs must carry the override.
    const stored: StoredRow[] = [
      {
        platform: FACEBOOK_PLATFORM,
        title: "Stored FB title",
        description: "Stored FB description.",
        copy: {
          copyBlock:
            "Stored FB title\n\nStored FB description.\n\nCondition: good\nAsking $100\nLocal pickup, message me if interested!",
        },
      },
      {
        platform: MERCARI_PLATFORM,
        title: "Stored Mercari title",
        description: "Stored Mercari description. Ships fast.",
        copy: { hashtags: ["#sony"], copyBlock: "Stored Mercari block. Ships." },
      },
      storedDepopRow(),
    ];
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, inserted), {
      userId: "user-1",
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewContentRevision: REVIEW_REVISION,
      attributes: CORE,
      suggestedPrice: 120,
      priceOverride: 177.77,
      generate,
    });

    // Still fully cached: no model call, no new rows.
    expect(calls()).toBe(0);
    expect(view.cached).toBe(true);
    expect(inserted).toHaveLength(0);
    expect(view.facebook.price).toBe(177.77);
    expect(view.mercari.price).toBe(177.77);
    // The FB block is rebuilt deterministically from the CURRENT price.
    expect(view.facebook.copyBlock).toContain("Asking $177.77");
    expect(view.facebook.copyBlock).not.toContain("$100");
    expect(view.facebook.copyBlock).not.toContain("$120");
    expect(view.facebook.copyBlock).toContain("Stored FB title");
    expect(view.facebook.copyBlock).toContain("Stored FB description.");
    expect(view.facebook.copyBlock).toContain("Condition: good");
    // Mercari carries no price line and is served verbatim.
    expect(view.mercari.copyBlock).toBe("Stored Mercari block. Ships.");
  });

  it("a cached Facebook block drops the price line when the item carries no current price", async () => {
    const stored: StoredRow[] = [
      {
        platform: FACEBOOK_PLATFORM,
        title: "Stored FB title",
        description: "Stored FB description.",
        copy: {
          copyBlock:
            "Stored FB title\n\nStored FB description.\n\nAsking $100\nLocal pickup, message me if interested!",
        },
      },
      {
        platform: MERCARI_PLATFORM,
        title: "Stored Mercari title",
        description: "Stored Mercari description. Ships fast.",
        copy: { hashtags: [], copyBlock: "Stored Mercari block. Ships." },
      },
      storedDepopRow(),
    ];
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, inserted), {
      userId: "user-1",
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewContentRevision: REVIEW_REVISION,
      attributes: CORE,
      generate,
    });

    expect(calls()).toBe(0);
    expect(view.cached).toBe(true);
    expect(view.facebook.copyBlock).not.toContain("Asking");
    expect(view.facebook.copyBlock).not.toContain("$");
  });

  it("a partial store regenerates but only inserts the missing platform", async () => {
    const stored: StoredRow[] = [
      {
        platform: FACEBOOK_PLATFORM,
        title: "Stored FB title",
        description: "Stored FB description.",
        copy: { copyBlock: "Stored FB title\n\nStored FB description." },
      },
    ];
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, inserted), {
      userId: "user-1",
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewContentRevision: REVIEW_REVISION,
      attributes: CORE,
      generate,
    });

    expect(calls()).toBe(1);
    expect(view.cached).toBe(false);
    // The stored FB pack is preserved; the two missing destinations are the
    // only ones newly generated + inserted.
    expect(view.facebook.title).toBe("Stored FB title");
    expect(inserted.map((r) => r.platform).sort()).toEqual([
      DEPOP_PLATFORM,
      MERCARI_PLATFORM,
    ]);
  });

  it("a stored row that fails its platform schema falls through to regeneration", async () => {
    const stored: StoredRow[] = [
      {
        platform: MERCARI_PLATFORM,
        // 41 chars — violates Mercari's 40-char title cap, so it must not render.
        title: "x".repeat(41),
        description: "Ships fast.",
        copy: { hashtags: [], copyBlock: "block" },
      },
    ];
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, inserted), {
      userId: "user-1",
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewContentRevision: REVIEW_REVISION,
      attributes: CORE,
      generate,
    });

    expect(calls()).toBe(1);
    expect(view.mercari.title.length).toBeLessThanOrEqual(40);
    const platforms = inserted.map((r) => r.platform).sort();
    expect(platforms).toEqual([DEPOP_PLATFORM, FACEBOOK_PLATFORM, MERCARI_PLATFORM]);
  });

  it("propagates a read error instead of silently regenerating", async () => {
    const filters = {
      eq: () => filters,
      in: () => ({
        order: async () => ({ data: null, error: { message: "boom" } }),
      }),
    };
    const client = {
      from: () => ({
        select: () => filters,
      }),
    } as unknown as SupabaseClient;
    const { generate } = countingGenerate();
    await expect(
      loadOrGenerateExportPacks(client, {
        userId: "user-1",
        itemId: "item-1",
        reviewRevision: REVIEW_REVISION,
        reviewContentRevision: REVIEW_REVISION,
        attributes: CORE,
        generate,
      }),
    ).rejects.toThrow(/Failed to read export packs: boom/);
  });

  it("does not accept a pack persisted after its source review revision changed", async () => {
    const { generate } = countingGenerate();
    await expect(
      loadOrGenerateExportPacks(
        fakeSupabase(
          [],
          [],
          [],
          { message: "Review changed. Reload and try again." },
        ),
        {
          userId: "user-1",
          itemId: "item-1",
          reviewRevision: REVIEW_REVISION,
          reviewContentRevision: REVIEW_REVISION,
          attributes: CORE,
          generate,
        },
      ),
    ).rejects.toThrow(/Failed to persist export packs: Review changed/i);
  });

  it("does not serve cached packs after the seller price revision changed", async () => {
    const stored: StoredRow[] = [
      {
        platform: FACEBOOK_PLATFORM,
        title: "Stored FB title",
        description: "Stored FB description.",
        copy: { copyBlock: "Stored FB block." },
      },
      {
        platform: MERCARI_PLATFORM,
        title: "Stored Mercari title",
        description: "Stored Mercari description.",
        copy: { copyBlock: "Stored Mercari block.", hashtags: [] },
      },
      storedDepopRow(),
    ];
    const changedRevision = "00000000-0000-4000-8000-000000000002";

    await expect(
      loadOrGenerateExportPacks(
        fakeSupabase(stored, [], [], null, {
          currentReviewRevision: () => changedRevision,
        }),
        {
          userId: "user-1",
          itemId: "item-1",
          reviewRevision: REVIEW_REVISION,
          reviewContentRevision: REVIEW_REVISION,
          attributes: CORE,
          suggestedPrice: 44.44,
          priceOverride: 177.77,
        },
      ),
    ).rejects.toThrow(/seller price changed/i);
  });

  it("does not return generated packs when the seller price changes after persistence", async () => {
    let currentReviewRevision = REVIEW_REVISION;
    const changedRevision = "00000000-0000-4000-8000-000000000003";
    const inserted: InsertedRow[] = [];

    await expect(
      loadOrGenerateExportPacks(
        fakeSupabase([], inserted, [], null, {
          currentReviewRevision: () => currentReviewRevision,
          afterPersist: () => {
            currentReviewRevision = changedRevision;
          },
        }),
        {
          userId: "user-1",
          itemId: "item-1",
          reviewRevision: REVIEW_REVISION,
          reviewContentRevision: REVIEW_REVISION,
          attributes: CORE,
          suggestedPrice: 44.44,
          priceOverride: 177.77,
          generate: countingGenerate().generate,
          model: "test-model",
        },
      ),
    ).rejects.toThrow(/seller price changed/i);
  });

  it("does not persist generated packs when the seller price changes during generation", async () => {
    let currentReviewRevision = REVIEW_REVISION;
    const changedRevision = "00000000-0000-4000-8000-000000000004";
    const inserted: InsertedRow[] = [];

    await expect(
      loadOrGenerateExportPacks(
        fakeSupabase([], inserted, [], null, {
          currentReviewRevision: () => currentReviewRevision,
        }),
        {
          userId: "user-1",
          itemId: "item-1",
          reviewRevision: REVIEW_REVISION,
          reviewContentRevision: REVIEW_REVISION,
          attributes: CORE,
          suggestedPrice: 44.44,
          priceOverride: 177.77,
          generate: async () => {
            currentReviewRevision = changedRevision;
            return RAW;
          },
          model: "test-model",
        },
      ),
    ).rejects.toThrow(/Failed to persist export packs: Seller price changed/i);
    expect(inserted).toHaveLength(0);
  });
});

/**
 * DEPOP + the effective-price precedence on CACHED packs (issue #378). This is
 * the issue's declared public RED seam: change the seller price after a pack
 * was generated, request delivery, and every destination — including the ones
 * served from persisted rows without a model call — must carry the NEW
 * effective price at the current revision. A cached pack that keeps an old
 * "Asking $X" line is a delivery path using a price the seller replaced.
 */
/** One valid persisted row per honest destination, written at an older price. */
function storedRowsForAllPlatforms(): StoredRow[] {
  return [
    {
      platform: FACEBOOK_PLATFORM,
      title: "Sony WH-1000XM4 headphones",
      description: "Selling my Sony headphones, good condition.",
      copy: {
        copyBlock:
          "Sony WH-1000XM4 headphones\n\nSelling my Sony headphones, good condition.\n\nAsking $44.44",
      },
    },
    {
      platform: MERCARI_PLATFORM,
      title: "Sony WH-1000XM4 Headphones",
      description: "Sony WH-1000XM4 in good condition. Ships next day.",
      copy: { hashtags: ["#sony"], copyBlock: "Stored Mercari block. Ships." },
    },
    storedDepopRow(),
  ];
}

describe("loadOrGenerateExportPacks — three honest destinations", () => {
  it("serves a cached pack per destination at the seller's current effective price", async () => {
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();

    const view = await loadOrGenerateExportPacks(
      fakeSupabase(storedRowsForAllPlatforms(), inserted),
      {
        userId: "user-1",
        itemId: "item-1",
        reviewRevision: REVIEW_REVISION,
        reviewContentRevision: REVIEW_REVISION,
        attributes: CORE,
        // The pack rows were written when the recommendation was 44.44; the
        // seller has since overridden the price.
        suggestedPrice: 44.44,
        priceOverride: 177.77,
        generate,
        model: "test-model",
      },
    );

    expect(calls()).toBe(0);
    expect(view.cached).toBe(true);
    expect(inserted).toHaveLength(0);
    expect(view.facebook.price).toBe(177.77);
    expect(view.mercari.price).toBe(177.77);
    expect(view.depop.price).toBe(177.77);
    expect(view.facebook.copyBlock).toContain("Asking $177.77");
    expect(view.facebook.copyBlock).not.toContain("44.44");
    expect(view.depop.copyBlock).toContain("Sony WH-1000XM4");
  });
});
