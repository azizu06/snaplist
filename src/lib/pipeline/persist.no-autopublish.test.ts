import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runPipelineAndPersist } from "./persist";
import type { Pipeline } from "./types";

interface RecordedWrite {
  operation: "insert" | "update";
  table: string;
  payload: Record<string, unknown>;
}

function recordingSupabase(): {
  client: SupabaseClient;
  writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  const ids: Record<string, string> = {
    items: "item-ready-1",
    listings: "listing-ready-1",
  };

  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          writes.push({ operation: "insert", table, payload });
          if (table === "prediction_logs") {
            return Promise.resolve({ error: null });
          }
          return {
            select() {
              return {
                single: async () => ({ data: { id: ids[table] }, error: null }),
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          writes.push({ operation: "update", table, payload });
          return { eq: async () => ({ error: null }) };
        },
        delete() {
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, writes };
}

const eligiblePipeline: Pipeline = {
  async run() {
    return {
      attributes: {
        brand: "Nintendo",
        model: "Game Boy Color",
        category: "video games",
        condition: "good",
      },
      price: {
        suggested: 89,
        range: { min: 75, max: 105 },
        confidence: 0.92,
        sources: [],
        tier: "ebay-sold",
      },
      confidence: {
        score: 0.92,
        band: "high",
        autopilotEligible: true,
      },
      listing: {
        platform: "ebay",
        title: "Nintendo Game Boy Color Console",
        description: "Tested and ready for a new collection.",
        fields: {},
      },
      model: "offline-test-model",
    };
  },
};

describe("eligible pipeline persistence", () => {
  it("marks the listing ready locally without publishing to a marketplace", async () => {
    const { client, writes } = recordingSupabase();
    // Persistence intentionally has no marketplace dependency. Guard the actual
    // eBay HTTP boundary anyway: if this path ever starts constructing an HTTP
    // adapter or calling a publish service, the forbidden fetch makes it visible.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("marketplace network must not run"));

    try {
      await runPipelineAndPersist(
        client,
        { userId: "user-1", photos: ["user-1/item.jpg"], autopilotEnabled: true },
        eligiblePipeline,
      );
    } finally {
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }

    const listingWrite = writes.find(
      (entry) => entry.operation === "insert" && entry.table === "listings",
    );
    expect(writes.map(({ operation, table }) => `${operation}:${table}`)).toEqual([
      "insert:items",
      "update:items",
      "insert:prediction_logs",
      "insert:listings",
    ]);
    expect(listingWrite?.payload).toMatchObject({ status: "queued" });
    for (const write of writes) {
      expect(Object.keys(write.payload).filter((key) => key.startsWith("ebay_"))).toEqual([]);
    }
  });
});
