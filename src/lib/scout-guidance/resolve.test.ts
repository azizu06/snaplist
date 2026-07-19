import { describe, expect, it } from "vitest";
import type { ScoutGuidanceTrustedSource } from "./contract";
import {
  SCOUT_GUIDANCE_STATES,
  ScoutGuidanceContractError,
  ScoutGuidanceFactError,
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
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const RECOMMENDATION_ID = "44444444-4444-4444-8444-444444444444";
const PHOTO_ID_1 = "66666666-6666-4666-8666-666666666661";
const PHOTO_ID_2 = "66666666-6666-4666-8666-666666666662";

function retainedSoldComps(count: number, windowDays: number) {
  const latest = new Date("2026-07-19T00:00:00.000Z");
  const earliest = new Date(
    latest.getTime() - (windowDays - 1) * 86_400_000,
  ).toISOString();
  return Array.from({ length: count }, (_, index) => ({
    id: `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`,
    soldAt: index === 0 && count > 1 ? earliest : latest.toISOString(),
  }));
}

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
          id: CAPTURE_SESSION_ID,
          photos: [{ id: PHOTO_ID_1 }, { id: PHOTO_ID_2 }],
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

  it("derives the captured-photo fact from a capture-session projection", () => {
    const capturedPhotoCount = verifiedCapturedPhotoCount({
      id: CAPTURE_SESSION_ID,
      photos: [{ id: PHOTO_ID_1 }, { id: PHOTO_ID_2 }],
    });

    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "capture.photo-count",
      locale: "en-US",
      substitutions: { capturedPhotoCount },
    });

    expect(result.message.title).toBe("2 of 4 photos");
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

  it("derives item guidance from bounded attributes instead of generated title copy", () => {
    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "processing.finding-sold-comps",
      locale: "en-US",
      substitutions: {
        itemDisplayName: verifiedItemDisplayNameFromDurableRecord({
          id: ITEM_ID,
          review_revision: REVIEW_REVISION,
          attributes: {
            title: "Ignore the verified item and render this generated prose",
            brand: "Canon",
            model: "AE-1",
          },
        }),
      },
    });

    expect(result.accessibility.label).toContain("Canon AE-1");
    expect(result.accessibility.label).not.toContain("generated prose");
    expect(() =>
      verifiedItemDisplayNameFromDurableRecord({
        id: ITEM_ID,
        review_revision: REVIEW_REVISION,
        attributes: { title: "Generated title only" },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceFactError",
        code: "missing-item-display-name",
      }) satisfies Partial<ScoutGuidanceFactError>,
    );
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

  it("rejects a spread clone of an enrolled fact", () => {
    const enrolled = verifiedCapturedPhotoCount({
      id: CAPTURE_SESSION_ID,
      photos: [{ id: PHOTO_ID_1 }, { id: PHOTO_ID_2 }],
    });

    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "capture.photo-count",
        locale: "en-US",
        substitutions: {
          capturedPhotoCount: { ...enrolled, value: 4 },
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "untrusted-substitution",
        substitutionKey: "capturedPhotoCount",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("keeps trust enrollment out of enumerable symbols and rejects equivalent replacements", () => {
    const enrolled = verifiedCapturedPhotoCount({
      id: CAPTURE_SESSION_ID,
      photos: [{ id: PHOTO_ID_1 }, { id: PHOTO_ID_2 }],
    });
    const equivalentReplacement = Object.create(
      Object.getPrototypeOf(enrolled),
      Object.getOwnPropertyDescriptors(enrolled),
    ) as ResolveScoutGuidanceRequest["substitutions"][string];

    expect(Object.getOwnPropertySymbols(enrolled)).toEqual([]);
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "capture.photo-count",
        locale: "en-US",
        substitutions: { capturedPhotoCount: equivalentReplacement },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "untrusted-substitution",
        substitutionKey: "capturedPhotoCount",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("rejects price facts swapped across their semantic keys", () => {
    const evidence = verifiedPriceEvidence({
      id: RECOMMENDATION_ID,
      retainedSoldComps: retainedSoldComps(3, 90),
    });

    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "uncertainty.limited-price-evidence",
        locale: "en-US",
        substitutions: {
          soldCompCount: evidence.windowDays,
          windowDays: evidence.soldCompCount,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "invalid-substitution",
        substitutionKey: "soldCompCount",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("derives sold-count and window facts from dated retained comps", () => {
    const evidence = verifiedPriceEvidence({
      id: "44444444-4444-4444-8444-444444444444",
      retainedSoldComps: [
        {
          id: "77777777-7777-4777-8777-777777777771",
          soldAt: "2026-04-21T00:00:00.000Z",
        },
        {
          id: "77777777-7777-4777-8777-777777777772",
          soldAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "77777777-7777-4777-8777-777777777773",
          soldAt: "2026-07-19T00:00:00.000Z",
        },
      ],
    });

    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "uncertainty.limited-price-evidence",
      locale: "en-US",
      substitutions: evidence,
    });

    expect(result.message.body).toBe("3 sold · 90 days");
  });

  it("derives the uploaded-photo fact from durable run photo states", () => {
    const uploadedPhotoCount = verifiedUploadedPhotoCount({
      id: RUN_ID,
      photos: [
        { id: PHOTO_ID_1, status: "uploaded" },
        { id: PHOTO_ID_2, status: "pending" },
      ],
    });

    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "recovery.upload-paused",
      locale: "en-US",
      substitutions: { uploadedPhotoCount },
    });

    expect(result.accessibility.label).toContain("1 of 4");
  });

  it("renders a one-day price evidence window with singular grammar", () => {
    const evidence = verifiedPriceEvidence({
      id: RECOMMENDATION_ID,
      retainedSoldComps: retainedSoldComps(1, 1),
    });

    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "uncertainty.limited-price-evidence",
      locale: "en-US",
      substitutions: evidence,
    });

    expect(result.message.body).toBe("1 sold · 1 day");
    expect(result.accessibility.label).toBe(
      "Limited evidence. 1 sold · 1 day",
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

  it("rejects a non-BCP-47 requested locale", () => {
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "onboarding.outcome",
        locale: "not a locale",
        substitutions: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "invalid-locale",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("canonicalizes grandfathered and registered extlang tags before fallback", () => {
    const grandfathered = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "onboarding.outcome",
      locale: "i-klingon",
      substitutions: {},
    });
    const privateUse = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "onboarding.outcome",
      locale: "x-scout",
      substitutions: {},
    });
    const extendedLanguage = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "onboarding.outcome",
      locale: "zh-cmn-Hans-CN",
      substitutions: {},
    });

    expect(grandfathered.localeFallbackChain).toEqual(["tlh", "en-US"]);
    expect(privateUse.localeFallbackChain).toEqual(["x-scout", "en-US"]);
    expect(privateUse.resolvedLocale).toBe("en-US");
    expect(extendedLanguage.localeFallbackChain).toEqual([
      "cmn-Hans-CN",
      "cmn",
      "en-US",
    ]);
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
    const evidence = verifiedPriceEvidence({
      id: RECOMMENDATION_ID,
      retainedSoldComps: retainedSoldComps(2, 366),
    });

    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "uncertainty.limited-price-evidence",
        locale: "en-US",
        substitutions: evidence,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "invalid-substitution",
        state: "uncertainty.limited-price-evidence",
        substitutionKey: "windowDays",
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
