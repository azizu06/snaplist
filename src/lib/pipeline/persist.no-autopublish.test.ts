import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runPipelineAndPersist } from "./persist";
import type { Pipeline } from "./types";

interface RecordedInsert {
  table: string;
  payload: Record<string, unknown>;
}

function recordingSupabase(): {
  client: SupabaseClient;
  inserts: RecordedInsert[];
} {
  const inserts: RecordedInsert[] = [];
  const ids: Record<string, string> = {
    items: "item-ready-1",
    listings: "listing-ready-1",
  };

  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          inserts.push({ table, payload });
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
        update() {
          return { eq: async () => ({ error: null }) };
        },
        delete() {
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, inserts };
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
    const { client, inserts } = recordingSupabase();
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

    const listingWrite = inserts.find((entry) => entry.table === "listings");
    expect(inserts.map((entry) => entry.table)).toEqual([
      "items",
      "prediction_logs",
      "listings",
    ]);
    expect(listingWrite?.payload).toMatchObject({ status: "queued" });
    expect(listingWrite?.payload).not.toHaveProperty("ebay_listing_id");
    expect(listingWrite?.payload).not.toHaveProperty("ebay_offer_id");
    expect(listingWrite?.payload).not.toHaveProperty("ebay_status");
  });
});
