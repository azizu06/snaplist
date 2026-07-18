import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scoutGuidanceCatalogSchema } from "./contract";
import {
  resolveScoutGuidance,
  type ResolveScoutGuidanceRequest,
} from "./resolve";

const catalog = JSON.parse(
  readFileSync(resolve("docs/contracts/scout-guidance-v1.json"), "utf8"),
);
const inventory = JSON.parse(
  readFileSync(resolve("docs/design/native-v1-design-inventory.json"), "utf8"),
) as {
  states: Array<{ id: string; status: string }>;
};
const assetManifests = [
  "ios/DesignContracts/V1/snaplist-asset-manifest.json",
  "ios/DesignContracts/Resolved/V1PlusRunRev/resolved/snaplist-asset-manifest.json",
].map(
  (path) =>
    JSON.parse(readFileSync(resolve(path), "utf8")) as {
      scout: Array<{
        file: string;
        allowed?: Array<{ state: string }>;
      }>;
    },
);

describe("Scout guidance catalog contract", () => {
  it("validates the checked-in provider-neutral V1 catalog", () => {
    expect(scoutGuidanceCatalogSchema.parse(catalog)).toEqual(catalog);
  });

  it("rejects substitution permissions that no localized template uses", () => {
    const widened = structuredClone(catalog);
    widened.states["onboarding.outcome"].substitutions.push({
      key: "arbitraryText",
      valueType: "text",
      trustedSources: ["seller-confirmed-item"],
      maximumLength: 80,
      referencePattern: "^item:",
    });

    const result = scoutGuidanceCatalogSchema.safeParse(widened);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message:
              "Approved substitution arbitraryText is unused by onboarding.outcome.",
          }),
        ]),
      );
    }
  });

  it("rejects partial locale dictionaries instead of mixing languages silently", () => {
    const partialLocale = structuredClone(catalog);
    partialLocale.locales.es = {
      "onboarding.outcome.title": "Fotografía un artículo.",
    };

    const result = scoutGuidanceCatalogSchema.safeParse(partialLocale);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message:
              "Locale es is missing copy key onboarding.outcome.body.",
          }),
        ]),
      );
    }
  });

  it("references only implementation-frozen states and approved Scout placements", () => {
    const frozenStateIds = new Set(
      inventory.states
        .filter((state) => state.status === "implementation_frozen")
        .map((state) => state.id),
    );
    const allowedPlacements = new Map<string, Set<string>>();
    for (const manifest of assetManifests) {
      for (const asset of manifest.scout) {
        const assetName = asset.file.split("/").at(-1) ?? asset.file;
        const states = allowedPlacements.get(assetName) ?? new Set<string>();
        for (const placement of asset.allowed ?? []) states.add(placement.state);
        allowedPlacements.set(assetName, states);
      }
    }

    for (const [state, definition] of Object.entries(catalog.states) as Array<
      [
        string,
        {
          approvedStateIds: string[];
          guide: { scoutAsset: string | null };
        },
      ]
    >) {
      for (const approvedStateId of definition.approvedStateIds) {
        expect(
          frozenStateIds.has(approvedStateId),
          `${state} must not reference candidate, withheld, or planned state ${approvedStateId}`,
        ).toBe(true);
        if (!definition.guide.scoutAsset) continue;
        const placementState = approvedStateId.startsWith("ONB-09-")
          ? "ONB-09"
          : approvedStateId.startsWith("CAP-02")
            ? "CAP-02"
            : approvedStateId;
        expect(
          allowedPlacements.get(definition.guide.scoutAsset)?.has(placementState),
          `${definition.guide.scoutAsset} is not approved for ${approvedStateId}`,
        ).toBe(true);
      }
    }
  });

  it("resolves every supported state without leaking template placeholders", () => {
    const parsedCatalog = scoutGuidanceCatalogSchema.parse(catalog);

    for (const [state, definition] of Object.entries(parsedCatalog.states)) {
      const substitutions = Object.fromEntries(
        definition.substitutions.map((rule) => [
          rule.key,
          rule.valueType === "integer"
            ? {
                source: rule.trustedSources[0],
                value: rule.minimum,
              }
            : {
                source: rule.trustedSources[0],
                reference:
                  "item:11111111-1111-4111-8111-111111111111:revision:1",
                value: "Verified item",
              },
        ]),
      );
      const result = resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state,
        locale: "en-US",
        substitutions,
      } as ResolveScoutGuidanceRequest);

      expect(result.message.title, state).not.toMatch(/[{}]/);
      expect(result.message.body ?? "", state).not.toMatch(/[{}]/);
      expect(result.accessibility.label, state).not.toMatch(/[{}]/);
      expect(result.guide).toMatchObject({
        optional: true,
        persistent: false,
        blocksPrimaryAction: false,
        motion: { reducedMotion: "static", loops: false },
      });
    }
  });
});
