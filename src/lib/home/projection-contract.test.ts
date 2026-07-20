import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { homeProjectionSchema } from "./projection";

const serverContractSource = readFileSync(
  resolve("docs/contracts/mobile-api-v1.openapi.json"),
  "utf8",
);
const nativeContractSource = readFileSync(
  resolve("ios/DesignContracts/V1/mobile-api-v1.openapi.json"),
  "utf8",
);
const contract = JSON.parse(serverContractSource) as {
  components: {
    schemas: Record<string, {
      required?: string[];
      properties?: Record<string, unknown>;
    }>;
  };
};

describe("Seller Home buyer-continuity contract", () => {
  it("keeps runtime and both OpenAPI copies aligned for typed conversation results", () => {
    expect(nativeContractSource).toBe(serverContractSource);

    const homeListing = contract.components.schemas.HomeListing;
    expect(homeListing.required).toContain("destination");
    expect(homeListing.properties).toMatchObject({
      lifecycle: {
        enum: ["active", "draft", "sold", "needsAttention", "resolvedConversation"],
      },
      destination: {
        oneOf: [
          { $ref: "#/components/schemas/HomeDestination" },
          { type: "null" },
        ],
      },
    });

    expect(() =>
      homeProjectionSchema.parse({
        revision: 1,
        sellerState: "active",
        unreadNotificationCount: 0,
        summary: { active: 1, drafts: 0, orders: null },
        attention: [],
        currentRun: null,
        readyToFinish: [],
        listings: [
          {
            id: "29600000-0000-4000-8000-000000000053",
            title: "Keychron K4 Mechanical Keyboard",
            lifecycle: "resolvedConversation",
            statusLabel: "Replied",
            detail: "eBay · You replied 1h ago",
            price: "$96",
            destination: {
              kind: "conversation",
              id: "29600000-0000-4000-8000-000000000053",
            },
          },
        ],
        recentSearches: [],
      }),
    ).not.toThrow();
  });
});
