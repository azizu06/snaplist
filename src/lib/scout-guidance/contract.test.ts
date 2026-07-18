import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadReviewSnapshot } from "@/lib/pipeline/review-snapshot";
import {
  appendAcceptedPhotos,
  type AppendAcceptedPhotosResult,
} from "@/lib/capture-progress";
import {
  parseSoldComps,
  synthesizeSoldResult,
} from "@/lib/pricing";
import {
  stageUploadEntries,
  type UploadProgressSnapshot,
} from "@/lib/upload-staging";
import { scoutGuidanceCatalogSchema } from "./contract";
import {
  resolveScoutGuidance,
  verifiedCapturedPhotoCount,
  verifiedItemDisplayNameFromDurableRecord,
  verifiedPriceEvidence,
  verifiedUploadedPhotoCount,
  type ResolveScoutGuidanceRequest,
  type VerifiedPriceEvidenceInput,
  type VerifiedScoutGuidanceFact,
} from "./resolve";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_REVISION = "33333333-3333-4333-8333-333333333333";
const CAPTURE_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const verifiedItemFacts = new Map<string, VerifiedScoutGuidanceFact>();
const captureProgress = new Map<number, AppendAcceptedPhotosResult>();
const uploadProgress = new Map<number, UploadProgressSnapshot>();
const priceEvidence = new Map<string, VerifiedPriceEvidenceInput>();

const photo = (index: number) =>
  new File([String(index)], `${index}.jpg`, { type: "image/jpeg" });

async function collectUploadProgress(photoCount: number): Promise<void> {
  await stageUploadEntries(
    {
      batchId: CAPTURE_SESSION_ID,
      userId: "user_test",
      dailyLimit: 10,
      perMinuteLimit: 5,
      entries: [{
        idempotencyKey: `capture-${photoCount}`,
        source: "single",
        autopilotEnabled: false,
        costBasis: null,
        photos: Array.from({ length: photoCount }, (_, index) => photo(index)),
      }],
    },
    {
      async upload() {},
      onUploadProgress(snapshot) {
        uploadProgress.set(uploadProgress.size + 1, snapshot);
      },
      async remove() {},
      async recordCleanupIntent() {},
      async resolveCleanupIntent() {},
      async findReplay() { return []; },
      async stageAndEnqueue() {
        return [{
          batch_id: CAPTURE_SESSION_ID,
          batch_position: 0,
          idempotency_key: `capture-${photoCount}`,
          item_id: ITEM_ID,
          run_id: RUN_ID,
          queue_message_id: "1",
          listing_id: null,
          status: "queued" as const,
          stage: "queued" as const,
          attempt_count: 0,
          max_attempts: 3,
          safe_failure_message: null,
          updated_at: "2026-07-18T00:00:00.000Z",
        }];
      },
    },
  );
}

function trustedPriceEvidence(
  soldCompCount: number,
  windowDays: number,
): VerifiedPriceEvidenceInput {
  const soldDate = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const cards = Array.from({ length: soldCompCount }, (_, index) => `
    <li class="s-item">
      <a class="s-item__link" href="https://www.ebay.com/itm/${200000 + index}">
        <div class="s-item__title">Canon AE-1 camera ${index}</div>
      </a>
      <span class="s-item__price">$40.00</span>
      <div class="s-item__caption">Sold ${soldDate}</div>
    </li>
  `).join("");
  const retrievedSoldComps = parseSoldComps(
    `<ul class="srp-results">${cards}</ul>`,
    "https://www.ebay.com",
    soldCompCount,
  );
  return {
    recommendation: synthesizeSoldResult(retrievedSoldComps),
    retrievedSoldComps,
    windowDays,
  };
}

async function loadVerifiedItemFact(
  displayName: string,
): Promise<VerifiedScoutGuidanceFact> {
  const snapshot = {
    item: {
      id: ITEM_ID,
      photos: [],
      attributes: { title: displayName },
      condition: null,
      identification: null,
      price_override: null,
      cost_basis: null,
      review_revision: REVIEW_REVISION,
      created_at: "2026-07-18T00:00:00.000Z",
    },
    listing: null,
    prediction: null,
    reviewBlocked: false,
  };
  const rpc = vi.fn(async () => ({ data: snapshot, error: null }));
  const loaded = await loadReviewSnapshot(
    { rpc } as unknown as SupabaseClient,
    ITEM_ID,
  );
  if (!loaded) throw new Error("Expected a trusted review snapshot fixture.");
  return verifiedItemDisplayNameFromDurableRecord(loaded);
}

function verifiedSubstitutionsFor(
  state: string,
  values: Record<string, string> = {},
): ResolveScoutGuidanceRequest["substitutions"] {
  switch (state) {
    case "capture.photo-count":
      return {
        capturedPhotoCount: verifiedCapturedPhotoCount(
          captureProgress.get(Number(values.capturedPhotoCount ?? 1))!,
        ),
      };
    case "processing.finding-sold-comps":
    case "retry.automatic": {
      const displayName = values.itemDisplayName ?? "Verified item";
      return {
        itemDisplayName: verifiedItemFacts.get(displayName)!,
      };
    }
    case "uncertainty.limited-price-evidence":
      return verifiedPriceEvidence(
        priceEvidence.get(
          `${Number(values.soldCompCount ?? 1)}:${Number(values.windowDays ?? 1)}`,
        )!,
      );
    case "recovery.upload-paused":
      return {
        uploadedPhotoCount: verifiedUploadedPhotoCount(
          uploadProgress.get(Number(values.uploadedPhotoCount ?? 2))!,
        ),
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
  beforeAll(async () => {
    for (const displayName of [
      "Verified item",
      "Canon AE-1 film camera",
      "AE-1 Program",
    ]) {
      verifiedItemFacts.set(displayName, await loadVerifiedItemFact(displayName));
    }
    captureProgress.set(1, appendAcceptedPhotos([], [photo(1)]));
    await collectUploadProgress(2);
    for (const [soldCompCount, windowDays] of [[1, 1], [3, 90]]) {
      priceEvidence.set(
        `${soldCompCount}:${windowDays}`,
        trustedPriceEvidence(soldCompCount, windowDays),
      );
    }
  });

  it("validates the checked-in provider-neutral V1 catalog", () => {
    expect(scoutGuidanceCatalogSchema.parse(catalog)).toEqual(catalog);
  });

  it("rejects invalid BCP 47 locale keys and defaultLocale values", () => {
    const invalid = structuredClone(catalog);
    invalid.defaultLocale = "pt_BR";
    invalid.locales.pt_BR = invalid.locales["en-US"];
    delete invalid.locales["en-US"];

    const result = scoutGuidanceCatalogSchema.safeParse(invalid);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["defaultLocale"],
            message: "Default locale pt_BR must be a valid BCP 47 language tag.",
          }),
          expect.objectContaining({
            path: ["locales", "pt_BR"],
            message: "Locale key pt_BR must be a valid BCP 47 language tag.",
          }),
        ]),
      );
    }
  });

  it("rejects locale aliases until keys and defaultLocale use canonical form", () => {
    const aliased = structuredClone(catalog);
    aliased.defaultLocale = "iw";
    aliased.locales.iw = aliased.locales["en-US"];
    delete aliased.locales["en-US"];

    const result = scoutGuidanceCatalogSchema.safeParse(aliased);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["defaultLocale"],
            message: "Default locale iw must use canonical form he.",
          }),
          expect.objectContaining({
            path: ["locales", "iw"],
            message: "Locale key iw must use canonical form he.",
          }),
        ]),
      );
    }
  });

  it("accepts canonical BCP 47 locale keys", () => {
    const canonical = structuredClone(catalog);
    canonical.locales["pt-BR"] = structuredClone(catalog.locales["en-US"]);

    expect(scoutGuidanceCatalogSchema.safeParse(canonical).success).toBe(true);
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

  it("uses machine-readable approved design copy for every semantic state", () => {
    const provenance = JSON.parse(
      readFileSync(
        resolve("src/lib/scout-guidance/approved-copy-provenance.v1.json"),
        "utf8",
      ),
    ) as {
      states: Record<string, { sources: Array<{ kind: string }> }>;
    };

    const nonMachineReadableSources = Object.entries(provenance.states).flatMap(
      ([state, definition]) =>
        definition.sources
          .filter((source) => source.kind === "source-text")
          .map(() => state),
    );

    expect(nonMachineReadableSources).toEqual([]);

    const approvedOverride = JSON.parse(
      readFileSync(
        resolve("docs/design/scout-guidance-copy-overrides.v1.json"),
        "utf8",
      ),
    ) as {
      version: string;
      status: string;
      strings_by_state: Record<string, string[]>;
    };
    expect(approvedOverride).toMatchObject({
      version: "scout-guidance-copy-overrides-v1",
      status: "approved-repo-override",
    });
    expect(Object.keys(approvedOverride.strings_by_state)).toEqual([
      "ONB-07",
      "CAP-02a",
    ]);
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
