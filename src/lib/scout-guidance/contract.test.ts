import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scoutGuidanceCatalogSchema } from "./contract";
import {
  resolveScoutGuidance,
  verifiedCapturedPhotoCount,
  verifiedItemDisplayNameFromDurableRecord,
  verifiedPriceEvidence,
  verifiedUploadedPhotoCount,
  type ResolveScoutGuidanceRequest,
} from "./resolve";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_REVISION = "33333333-3333-4333-8333-333333333333";
const CAPTURE_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const RECOMMENDATION_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

function verifiedSubstitutionsFor(
  state: string,
  values: Record<string, string> = {},
): ResolveScoutGuidanceRequest["substitutions"] {
  switch (state) {
    case "capture.photo-count":
      return {
        capturedPhotoCount: verifiedCapturedPhotoCount({
          captureSessionId: CAPTURE_SESSION_ID,
          capturedPhotoCount: Number(values.capturedPhotoCount ?? 1),
        }),
      };
    case "processing.finding-sold-comps":
    case "retry.automatic":
      return {
        itemDisplayName: verifiedItemDisplayNameFromDurableRecord({
          id: ITEM_ID,
          review_revision: REVIEW_REVISION,
          attributes: { brand: values.itemDisplayName ?? "Verified item" },
        }),
      };
    case "uncertainty.limited-price-evidence":
      return verifiedPriceEvidence({
        recommendationId: RECOMMENDATION_ID,
        soldCompCount: Number(values.soldCompCount ?? 1),
        windowDays: Number(values.windowDays ?? 1),
      });
    case "recovery.upload-paused":
      return {
        uploadedPhotoCount: verifiedUploadedPhotoCount({
          runId: RUN_ID,
          uploadedPhotoCount: Number(values.uploadedPhotoCount ?? 0),
        }),
      };
    default:
      return {};
  }
}

const catalog = JSON.parse(
  readFileSync(resolve("src/lib/scout-guidance/catalog.v1.json"), "utf8"),
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

  it("enforces exact approved placeholders and balanced braces in every locale", () => {
    const withSpanish = structuredClone(catalog);
    withSpanish.locales.es = structuredClone(catalog.locales["en-US"]);

    const introduced = structuredClone(withSpanish);
    introduced.locales.es["capture.photo-count.title"] =
      "{capturedPhotoCount} de 4 fotos {arbitraryText}";
    const omitted = structuredClone(withSpanish);
    omitted.locales.es["capture.photo-count.title"] = "Fotos capturadas";
    const malformed = structuredClone(withSpanish);
    malformed.locales.es["capture.photo-count.title"] =
      "{capturedPhotoCount de 4 fotos";

    for (const invalidCatalog of [introduced, omitted]) {
      const result = scoutGuidanceCatalogSchema.safeParse(invalidCatalog);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message:
                "Locale es template capture.photo-count.title must use exactly approved variables: capturedPhotoCount.",
            }),
          ]),
        );
      }
    }

    const malformedResult = scoutGuidanceCatalogSchema.safeParse(malformed);
    expect(malformedResult.success).toBe(false);
    if (!malformedResult.success) {
      expect(malformedResult.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message:
              "Locale es copy key capture.photo-count.title contains malformed template braces.",
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

  it("matches the authoritative semantic-state and exact-copy provenance fixture", () => {
    const provenance = JSON.parse(
      readFileSync(
        resolve("src/lib/scout-guidance/approved-copy-provenance.v1.json"),
        "utf8",
      ),
    ) as {
      contractVersion: string;
      states: Record<
        string,
        {
          approvedStateIds: string[];
          templates: {
            title: string;
            body: string | null;
            accessibilityLabel: string;
          };
          canonicalSubstitutions: Record<string, string>;
          expected: {
            title: string;
            body: string | null;
            accessibilityLabel: string;
          };
          sources: Array<{
            kind:
              | "json-string-keys"
              | "json-screen-copy"
              | "json-state-copy"
              | "source-text";
            path: string;
            keys?: string[];
            stateId?: string;
            fragments: string[];
          }>;
        }
      >;
    };

    expect(provenance.contractVersion).toBe(catalog.contractVersion);
    expect(Object.keys(provenance.states)).toEqual(Object.keys(catalog.states));
    for (const [state, expected] of Object.entries(provenance.states)) {
      const definition = catalog.states[state];
      expect(definition.approvedStateIds, state).toEqual(
        expected.approvedStateIds,
      );
      expect(catalog.locales["en-US"][definition.copyKeys.title], state).toBe(
        expected.templates.title,
      );
      expect(
        definition.copyKeys.body
          ? catalog.locales["en-US"][definition.copyKeys.body]
          : null,
        state,
      ).toBe(expected.templates.body);
      expect(
        catalog.locales["en-US"][definition.copyKeys.accessibilityLabel],
        state,
      ).toBe(expected.templates.accessibilityLabel);

      for (const source of expected.sources) {
        const sourceText = readFileSync(resolve(source.path), "utf8");
        if (source.kind === "source-text") {
          for (const fragment of source.fragments) {
            expect(sourceText, `${state} source ${source.path}`).toContain(
              `"${fragment}"`,
            );
          }
          continue;
        }

        const sourceCatalog = JSON.parse(sourceText) as {
          strings?: Record<string, string>;
          screens?: Array<{ id: string; copy?: string[] }>;
          strings_by_state?: Record<string, string[]>;
          exact_strings_by_state?: Record<string, string[]>;
        };
        let approvedFragments: string[] = [];
        if (source.kind === "json-string-keys") {
          approvedFragments = (source.keys ?? []).map(
            (key) => sourceCatalog.strings?.[key] ?? "",
          );
        } else if (source.kind === "json-screen-copy") {
          approvedFragments =
            sourceCatalog.screens?.find((screen) => screen.id === source.stateId)
              ?.copy ?? [];
        } else {
          approvedFragments = [
            ...(sourceCatalog.strings_by_state?.[source.stateId ?? ""] ?? []),
            ...(sourceCatalog.exact_strings_by_state?.[source.stateId ?? ""] ??
              []),
          ];
        }
        for (const fragment of source.fragments) {
          expect(
            approvedFragments,
            `${state} fragment must exist verbatim in ${source.path}`,
          ).toContain(fragment);
        }
      }

      const resolvedGuidance = resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state,
        locale: "en-US",
        substitutions: verifiedSubstitutionsFor(
          state,
          expected.canonicalSubstitutions,
        ),
      } as ResolveScoutGuidanceRequest);
      expect(resolvedGuidance.message, state).toEqual({
        title: expected.expected.title,
        body: expected.expected.body,
      });
      expect(resolvedGuidance.accessibility.label, state).toBe(
        expected.expected.accessibilityLabel,
      );
    }
  });

  it("resolves every supported state without leaking template placeholders", () => {
    const parsedCatalog = scoutGuidanceCatalogSchema.parse(catalog);

    for (const state of Object.keys(parsedCatalog.states)) {
      const result = resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state,
        locale: "en-US",
        substitutions: verifiedSubstitutionsFor(state),
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
