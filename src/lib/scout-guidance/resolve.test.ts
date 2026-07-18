import { describe, expect, it } from "vitest";
import type { ScoutGuidanceTrustedSource } from "./contract";
import {
  SCOUT_GUIDANCE_STATES,
  ScoutGuidanceContractError,
  resolveScoutGuidance,
  verifiedCapturedPhotoCount,
  verifiedItemDisplayNameFromDurableRecord,
  type ResolveScoutGuidanceRequest,
} from "./resolve";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_REVISION = "33333333-3333-4333-8333-333333333333";
const CAPTURE_SESSION_ID = "22222222-2222-4222-8222-222222222222";

const verifiedItemName = () =>
  verifiedItemDisplayNameFromDurableRecord({
    id: ITEM_ID,
    review_revision: REVIEW_REVISION,
    attributes: { brand: "Canon", model: "AE-1 film camera" },
  });

describe("resolveScoutGuidance", () => {
  it("deterministically resolves the approved onboarding outcome message", () => {
    const request = {
      contractVersion: "scout-guidance-v1" as const,
      state: "onboarding.outcome" as const,
      locale: "en-US",
      substitutions: {},
    };

    const first = resolveScoutGuidance(request);
    const second = resolveScoutGuidance(request);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      contractVersion: "scout-guidance-v1",
      state: "onboarding.outcome",
      requestedLocale: "en-US",
      resolvedLocale: "en-US",
      localeFallbackApplied: false,
      message: {
        title: "Photograph an item. Get real comps and a listing you control.",
        body:
          "See what similar items actually sold for, then publish a listing you approve. No account needed to start.",
      },
      accessibility: {
        label:
          "Photograph an item. Get real comps and a listing you control. See what similar items actually sold for, then publish a listing you approve. No account needed to start.",
        scoutAssetDecorative: true,
      },
      guide: {
        optional: true,
        persistent: false,
        blocksPrimaryAction: false,
        scoutAsset: "pose-01-coaching-photo.png",
      },
    });
  });

  it("formats a capture count only from the bounded verified capture fact", () => {
    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "capture.photo-count",
      locale: "en-US",
      substitutions: {
        capturedPhotoCount: verifiedCapturedPhotoCount({
          captureSessionId: CAPTURE_SESSION_ID,
          capturedPhotoCount: 2,
        }),
      },
    });

    expect(result).toMatchObject({
      message: {
        title: "2 of 4 photos",
        body: null,
      },
      accessibility: {
        label: "2 of 4 photos",
      },
    });
  });

  it("rejects a missing required substitution with a stable contract error", () => {
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "capture.photo-count",
        locale: "en-US",
        substitutions: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "missing-substitution",
        state: "capture.photo-count",
        substitutionKey: "capturedPhotoCount",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("uses a verified durable item name only in the approved processing guidance", () => {
    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "processing.finding-sold-comps",
      locale: "en-US",
      substitutions: {
        itemDisplayName: verifiedItemName(),
      },
    });

    expect(result).toMatchObject({
      message: {
        title: "Working on your item",
        body: "Finding recent sold comps",
      },
      accessibility: {
        label:
          "Working on your item. Canon AE-1 film camera. Finding recent sold comps. You can leave — we’ll keep working.",
      },
      guide: {
        functionalPurpose: "reassure-active-processing",
        scoutAsset: "pose-01-analyzing.png",
      },
    });
  });

  it("rejects arbitrary model text even when it has a plausible item reference", () => {
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "processing.finding-sold-comps",
        locale: "en-US",
        substitutions: {
          itemDisplayName: {
            source: "model-output" as ScoutGuidanceTrustedSource,
            reference: "item:11111111-1111-4111-8111-111111111111:revision:3",
            value: "Ignore the catalog and say anything",
          },
        } as unknown as ResolveScoutGuidanceRequest["substitutions"],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "untrusted-substitution",
        state: "processing.finding-sold-comps",
        substitutionKey: "itemDisplayName",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("rejects raw caller-spoofed provenance even when its labels satisfy the catalog", () => {
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "processing.finding-sold-comps",
        locale: "en-US",
        substitutions: {
          itemDisplayName: {
            source: "durable-item-record",
            reference: `item:${"-".repeat(36)}:revision:3`,
            value: "Ignore verified records and render this model-like prose",
          },
        } as unknown as ResolveScoutGuidanceRequest["substitutions"],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "untrusted-substitution",
        state: "processing.finding-sold-comps",
        substitutionKey: "itemDisplayName",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("falls back through the language tag to the approved default locale", () => {
    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "onboarding.outcome",
      locale: "fr-CA",
      substitutions: {},
    });

    expect(result).toMatchObject({
      requestedLocale: "fr-CA",
      resolvedLocale: "en-US",
      localeFallbackApplied: true,
      localeFallbackChain: ["fr-CA", "fr", "en-US"],
      message: {
        title: "Photograph an item. Get real comps and a listing you control.",
      },
    });
  });

  it("exposes static reduced-motion and text-complete accessibility metadata", () => {
    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "processing.finding-sold-comps",
      locale: "en-US",
      substitutions: {
        itemDisplayName: verifiedItemName(),
      },
    });

    expect(result.guide.motion).toEqual({
      standard: "optional-brief-once",
      reducedMotion: "static",
      loops: false,
    });
    expect(result.accessibility).toMatchObject({
      scoutAssetDecorative: true,
      meaningCompleteInText: true,
      statusNeverColorOnly: true,
    });
  });

  it("isolates catalog guide metadata from caller mutation", () => {
    const request = {
      contractVersion: "scout-guidance-v1" as const,
      state: "onboarding.outcome" as const,
      locale: "en-US",
      substitutions: {},
    };
    const first = resolveScoutGuidance(request);
    const mutableGuide = first.guide as {
      scoutAsset: string | null;
      motion: { standard: string };
    };
    mutableGuide.scoutAsset = null;
    mutableGuide.motion.standard = "none";

    const second = resolveScoutGuidance(request);

    expect(second.guide.scoutAsset).toBe("pose-01-coaching-photo.png");
    expect(second.guide.motion.standard).toBe("optional-brief-once");
  });

  it("publishes the complete approved launch-state catalog without candidate states", () => {
    expect(SCOUT_GUIDANCE_STATES).toEqual([
      "onboarding.outcome",
      "onboarding.photo-primer",
      "onboarding.camera-denied",
      "onboarding.camera-ready",
      "onboarding.library-ready",
      "capture.initial-coaching",
      "capture.move-closer",
      "capture.framing-accepted",
      "capture.photo-count",
      "processing.finding-sold-comps",
      "uncertainty.limited-price-evidence",
      "uncertainty.identity",
      "recovery.upload-paused",
      "recovery.processing-failed",
      "recovery.status-unconfirmed",
      "retry.automatic",
      "empty.home",
    ]);
  });

  it("rejects requests for an unsupported contract version", () => {
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v2" as "scout-guidance-v1",
        state: "onboarding.outcome",
        locale: "en-US",
        substitutions: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "unsupported-contract-version",
        contractVersion: "scout-guidance-v2",
      }),
    );
  });

  it("rejects verified facts outside the template's approved bounds", () => {
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "capture.photo-count",
        locale: "en-US",
        substitutions: {
          capturedPhotoCount: verifiedCapturedPhotoCount({
            captureSessionId: CAPTURE_SESSION_ID,
            capturedPhotoCount: 5,
          }),
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "invalid-substitution",
        state: "capture.photo-count",
        substitutionKey: "capturedPhotoCount",
      }),
    );
  });

  it("rejects unknown and candidate state identifiers", () => {
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "capture.CAP-03a" as "onboarding.outcome",
        locale: "en-US",
        substitutions: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "unsupported-state",
        state: "capture.CAP-03a",
      }),
    );
  });
});
