import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedAttributes } from "../pipeline/types";
import { FACEBOOK_PLATFORM, MERCARI_PLATFORM, type RawExportPacks } from "./schema";
import type { ExportPackGenerate } from "./generate";
import { loadOrGenerateExportPacks } from "./persist";

/**
 * Load-or-generate seam tests (issue #15). Fully OFFLINE: a minimal fake
 * Supabase client (just the query-builder surface this helper touches) plus an
 * injected fake model call. Asserts the seam behavior:
 *
 *  - first visit: generates, persists ONE draft listings row per platform
 *    (user-pinned for RLS WITH CHECK), returns the fresh packs;
 *  - later visits: serves the persisted rows verbatim, NO model call;
 *  - invalid/partial stored rows fall through to regeneration without
 *    duplicating the platform that was already covered.
 */

interface InsertedRow {
  user_id: string;
  item_id: string;
  platform: string;
  title: string;
  description: string;
  copy: Record<string, unknown>;
  status: string;
}

interface StoredRow {
  platform: string;
  title: string | null;
  description: string | null;
  copy: Record<string, unknown> | null;
}

/** Fake of exactly the chains persist.ts uses: select().eq().in().order() and insert(). */
function fakeSupabase(rows: StoredRow[], inserted: InsertedRow[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "listings") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            in: () => ({
              order: async () => ({ data: rows, error: null }),
            }),
          }),
        }),
        insert: async (values: InsertedRow[]) => {
          inserted.push(...values);
          return { error: null };
        },
      };
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
  it("first visit: generates, persists a draft row per platform, returns fresh packs", async () => {
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase([], inserted), {
      userId: "user-1",
      itemId: "item-1",
      attributes: CORE,
      price: 120,
      generate,
      model: "test-model",
    });

    expect(calls()).toBe(1);
    expect(view.cached).toBe(false);
    expect(view.model).toBe("test-model");
    expect(view.facebook.copyBlock).toContain("Asking $120");
    expect(view.mercari.hashtags.length).toBeGreaterThan(0);

    expect(inserted).toHaveLength(2);
    const platforms = inserted.map((r) => r.platform).sort();
    expect(platforms).toEqual([FACEBOOK_PLATFORM, MERCARI_PLATFORM]);
    for (const row of inserted) {
      expect(row.user_id).toBe("user-1");
      expect(row.item_id).toBe("item-1");
      expect(row.status).toBe("draft");
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
    ];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, []), {
      userId: "user-1",
      itemId: "item-1",
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
    ];
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, inserted), {
      userId: "user-1",
      itemId: "item-1",
      attributes: CORE,
      generate,
    });

    expect(calls()).toBe(0);
    expect(view.cached).toBe(true);
    expect(view.facebook.title).toBe("Stored FB title");
    expect(view.mercari.hashtags).toEqual(["#sony"]);
    expect(inserted).toHaveLength(0);
  });

  it("a cached Facebook block always reflects the CURRENT price, never the persisted snapshot", async () => {
    // The pack was generated when the price was 100; a new pricing run says 120.
    const stored: StoredRow[] = [
      {
        platform: FACEBOOK_PLATFORM,
        title: "Stored FB title",
        description: "Stored FB description.",
        copy: {
          copyBlock:
            "Stored FB title\n\nStored FB description.\n\nCondition: good\nAsking $100\nLocal pickup — message me if interested!",
        },
      },
      {
        platform: MERCARI_PLATFORM,
        title: "Stored Mercari title",
        description: "Stored Mercari description. Ships fast.",
        copy: { hashtags: ["#sony"], copyBlock: "Stored Mercari block. Ships." },
      },
    ];
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, inserted), {
      userId: "user-1",
      itemId: "item-1",
      attributes: CORE,
      price: 120,
      generate,
    });

    // Still fully cached: no model call, no new rows.
    expect(calls()).toBe(0);
    expect(view.cached).toBe(true);
    expect(inserted).toHaveLength(0);
    // The FB block is rebuilt deterministically from the CURRENT price.
    expect(view.facebook.copyBlock).toContain("Asking $120");
    expect(view.facebook.copyBlock).not.toContain("$100");
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
            "Stored FB title\n\nStored FB description.\n\nAsking $100\nLocal pickup — message me if interested!",
        },
      },
      {
        platform: MERCARI_PLATFORM,
        title: "Stored Mercari title",
        description: "Stored Mercari description. Ships fast.",
        copy: { hashtags: [], copyBlock: "Stored Mercari block. Ships." },
      },
    ];
    const inserted: InsertedRow[] = [];
    const { generate, calls } = countingGenerate();
    const view = await loadOrGenerateExportPacks(fakeSupabase(stored, inserted), {
      userId: "user-1",
      itemId: "item-1",
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
      attributes: CORE,
      generate,
    });

    expect(calls()).toBe(1);
    expect(view.cached).toBe(false);
    // The stored FB pack is preserved; only Mercari is newly generated + inserted.
    expect(view.facebook.title).toBe("Stored FB title");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.platform).toBe(MERCARI_PLATFORM);
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
      attributes: CORE,
      generate,
    });

    expect(calls()).toBe(1);
    expect(view.mercari.title.length).toBeLessThanOrEqual(40);
    const platforms = inserted.map((r) => r.platform).sort();
    expect(platforms).toEqual([FACEBOOK_PLATFORM, MERCARI_PLATFORM]);
  });

  it("propagates a read error instead of silently regenerating", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => ({
              order: async () => ({ data: null, error: { message: "boom" } }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const { generate } = countingGenerate();
    await expect(
      loadOrGenerateExportPacks(client, {
        userId: "user-1",
        itemId: "item-1",
        attributes: CORE,
        generate,
      }),
    ).rejects.toThrow(/Failed to read export packs: boom/);
  });
});
