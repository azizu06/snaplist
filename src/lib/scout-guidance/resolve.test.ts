import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ScoutGuidanceTrustedSource } from "./contract";
import {
  loadReviewSnapshot,
  type ReviewSnapshot,
} from "@/lib/pipeline/review-snapshot";
import {
  createApifySoldPricingProvider,
  createEbaySoldPricingProvider,
  parseSoldComps,
  PriceRouter,
  synthesizeSoldResult,
  type PriceResult,
  type PricingProvider,
} from "@/lib/pricing";
import { appendAcceptedPhotos } from "@/app/(app)/upload/upload-draft-context";
import type { AppendAcceptedPhotosResult } from "@/lib/capture-progress";
import {
  stageUploadEntries,
  type UploadProgressSnapshot,
  type UploadStagingDependencies,
} from "@/lib/upload-staging";
import {
  SCOUT_GUIDANCE_STATES,
  ScoutGuidanceContractError,
  resolveScoutGuidance,
  verifiedCapturedPhotoCount,
  verifiedItemDisplayNameFromDurableRecord,
  verifiedPriceEvidence,
  verifiedUploadedPhotoCount,
  type ResolveScoutGuidanceRequest,
  type VerifiedScoutGuidanceFact,
} from "./resolve";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_REVISION = "33333333-3333-4333-8333-333333333333";
const CAPTURE_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const RECOMMENDATION_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

function arbitraryParsedPriceRecommendation(
  soldCompCount: number,
  soldCaption?: string,
): PriceResult {
  const soldDate = new Date().toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" },
  );
  const cards = Array.from({ length: soldCompCount }, (_, index) => `
    <li class="s-item">
      <a class="s-item__link" href="https://www.ebay.com/itm/${100000 + index}">
        <div class="s-item__title">Canon AE-1 camera ${index}</div>
      </a>
      <span class="s-item__price">$40.00</span>
      <div class="s-item__caption">${soldCaption ?? `Sold ${soldDate}`}</div>
    </li>
  `).join("");
  const retrievedSoldComps = parseSoldComps(
    `<ul class="srp-results">${cards}</ul>`,
    "https://www.ebay.com",
    soldCompCount,
  );
  return synthesizeSoldResult(retrievedSoldComps);
}

async function routedPriceRecommendation(
  soldCompCount: number,
  windowDays: number,
  soldAt: number | null = Date.now() - (windowDays - 0.5) * 86_400_000,
): Promise<PriceResult> {
  const provider: PricingProvider = {
    tier: "ebay-sold",
    async price() {
      return synthesizeSoldResult(
        Array.from({ length: soldCompCount }, (_, index) => ({
          url: `https://www.ebay.com/itm/routed-${soldCompCount}-${index}`,
          title: `Canon AE-1 camera ${index}`,
          price: 40,
          ...(soldAt !== null ? { soldAt } : {}),
        })),
      );
    },
  };
  return new PriceRouter([provider]).price({ brand: "Canon", model: "AE-1" });
}

async function loadTrustedItemSnapshot(
  attributes: unknown,
): Promise<ReviewSnapshot> {
  const snapshot = {
    item: {
      id: ITEM_ID,
      photos: [],
      attributes,
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
  return loaded;
}

async function loadVerifiedItemName(
  attributes: unknown,
): Promise<VerifiedScoutGuidanceFact> {
  return verifiedItemDisplayNameFromDurableRecord(
    await loadTrustedItemSnapshot(attributes),
  );
}

let verifiedItemNameFact: VerifiedScoutGuidanceFact;

const verifiedItemName = () => verifiedItemNameFact;

describe("resolveScoutGuidance", () => {
  beforeAll(async () => {
    verifiedItemNameFact = await loadVerifiedItemName({
      brand: "Canon",
      model: "AE-1 film camera",
    });
  });
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

  it("formats accepted capture progress before upload staging begins", () => {
    const stageAndEnqueue = vi.fn();
    const capture = appendAcceptedPhotos([], [
      new File(["front"], "front.jpg", { type: "image/jpeg" }),
      new File(["back"], "back.jpg", { type: "image/jpeg" }),
    ]);
    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "capture.photo-count",
      locale: "en-US",
      substitutions: {
        capturedPhotoCount: verifiedCapturedPhotoCount(capture),
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
    expect(stageAndEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a caller-constructed object at the capture-session fact boundary", () => {
    expect(() =>
      verifiedCapturedPhotoCount({
        captureSessionId: CAPTURE_SESSION_ID,
        capturedPhotoCount: 2,
      } as unknown as AppendAcceptedPhotosResult),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceFactError",
        code: "untrusted-capture-session",
      }),
    );
  });

  it("rejects a caller-constructed object at the upload-progress fact boundary", () => {
    expect(() =>
      verifiedUploadedPhotoCount({
        runId: RUN_ID,
        uploadedPhotoCount: 2,
      } as unknown as UploadProgressSnapshot),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceFactError",
        code: "untrusted-upload-progress",
      }),
    );
  });

  it("formats per-photo upload progress before the durable run is staged", async () => {
    const events: string[] = [];
    const resolvedLabels: string[] = [];
    const dependencies = {
      async upload(_path: string, photo: File) {
        events.push(`upload:${photo.name}`);
      },
      async remove() {},
      async recordCleanupIntent() {},
      async resolveCleanupIntent() {},
      async findReplay() {
        return [];
      },
      async stageAndEnqueue() {
        events.push("stage");
        return [{
          batch_id: CAPTURE_SESSION_ID,
          batch_position: 0,
          idempotency_key: "capture-1",
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
      onUploadProgress(
        snapshot: Parameters<typeof verifiedUploadedPhotoCount>[0],
      ) {
        events.push("progress");
        resolvedLabels.push(
          resolveScoutGuidance({
            contractVersion: "scout-guidance-v1",
            state: "recovery.upload-paused",
            locale: "en-US",
            substitutions: {
              uploadedPhotoCount: verifiedUploadedPhotoCount(snapshot),
            },
          }).accessibility.label,
        );
      },
    } satisfies UploadStagingDependencies & {
      onUploadProgress(
        snapshot: Parameters<typeof verifiedUploadedPhotoCount>[0],
      ): void;
    };

    await stageUploadEntries(
      {
        batchId: CAPTURE_SESSION_ID,
        userId: "user_test",
        dailyLimit: 10,
        perMinuteLimit: 5,
        entries: [{
          idempotencyKey: "capture-1",
          source: "single",
          autopilotEnabled: false,
          costBasis: null,
          photos: [
            new File(["front"], "front.jpg", { type: "image/jpeg" }),
            new File(["back"], "back.jpg", { type: "image/jpeg" }),
          ],
        }],
      },
      dependencies,
    );

    expect(events).toEqual([
      "upload:front.jpg",
      "progress",
      "upload:back.jpg",
      "progress",
      "stage",
    ]);
    expect(resolvedLabels.at(-1)).toContain("2 of 4");
  });

  it("limits interrupted-upload copy to photos completed before cleanup", async () => {
    let progress: UploadProgressSnapshot | undefined;
    let uploadAttempt = 0;
    const remove = vi.fn(async () => undefined);

    await expect(
      stageUploadEntries(
        {
          batchId: CAPTURE_SESSION_ID,
          userId: "user_test",
          dailyLimit: 10,
          perMinuteLimit: 5,
          entries: [{
            idempotencyKey: "interrupted-upload",
            source: "single",
            autopilotEnabled: false,
            costBasis: null,
            photos: [
              new File(["front"], "front.jpg", { type: "image/jpeg" }),
              new File(["back"], "back.jpg", { type: "image/jpeg" }),
            ],
          }],
        },
        {
          async upload() {
            uploadAttempt += 1;
            if (uploadAttempt === 2) throw new Error("connection lost");
          },
          onUploadProgress(snapshot) {
            progress = snapshot;
          },
          remove,
          async recordCleanupIntent() {},
          async resolveCleanupIntent() {},
          async findReplay() { return []; },
          async stageAndEnqueue() { return []; },
        },
      ),
    ).rejects.toThrow("connection lost");
    expect(remove).toHaveBeenCalledOnce();

    const guidance = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "recovery.upload-paused",
      locale: "en-US",
      substitutions: {
        uploadedPhotoCount: verifiedUploadedPhotoCount(progress!),
      },
    });

    expect(guidance.message.body).toBe(
      "1 of 4 photos finished uploading before this attempt stopped",
    );
    expect(guidance.accessibility.label).toBe(
      "Upload paused. 1 of 4 photos finished uploading before this attempt stopped.",
    );
    expect(guidance.accessibility.label).not.toMatch(
      /safe|device|reconnect|resume/i,
    );
  });

  it("rejects verified price facts swapped into a different substitution key", async () => {
    const evidence = verifiedPriceEvidence(
      await routedPriceRecommendation(3, 90),
    );

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
        code: "untrusted-substitution",
        state: "uncertainty.limited-price-evidence",
        substitutionKey: "soldCompCount",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("rejects related price facts mixed across recommendation bundles", async () => {
    const first = verifiedPriceEvidence(
      await routedPriceRecommendation(3, 90),
    );
    const second = verifiedPriceEvidence(
      await routedPriceRecommendation(4, 90),
    );

    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "uncertainty.limited-price-evidence",
        locale: "en-US",
        substitutions: {
          soldCompCount: first.soldCompCount,
          windowDays: second.windowDays,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "untrusted-substitution",
        state: "uncertainty.limited-price-evidence",
        substitutionKey: "windowDays",
      }) satisfies Partial<ScoutGuidanceContractError>,
    );
  });

  it("rejects caller-labelled counts at the price-recommendation fact boundary", () => {
    expect(() =>
      verifiedPriceEvidence({
        recommendationId: RECOMMENDATION_ID,
        soldCompCount: 90,
        windowDays: 3,
      } as unknown as PriceResult),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceFactError",
        code: "untrusted-price-recommendation",
      }),
    );
  });

  it("fails closed when a PriceResult does not prove every comp is inside its claimed window", async () => {
    const recommendation = arbitraryParsedPriceRecommendation(3);

    expect(() =>
      verifiedPriceEvidence(
        recommendation as unknown as Parameters<typeof verifiedPriceEvidence>[0],
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceFactError",
        code: "untrusted-price-recommendation",
      }),
    );
  });

  it("rejects arbitrary sold HTML parsed outside the pricing router", () => {
    expect(() =>
      verifiedPriceEvidence(arbitraryParsedPriceRecommendation(3)),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceFactError",
        code: "untrusted-price-recommendation",
      }),
    );
  });

  it("accepts normalized Apify sold evidence returned by the pricing router", async () => {
    const observedAt = Date.now();
    const endedAt = new Date(observedAt - 8.5 * 86_400_000).toISOString();
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "test-only-token",
      now: () => observedAt,
      runActor: async () => ({
        status: "SUCCEEDED",
        items: [170, 180, 190].map((soldPrice, index) => ({
          url: `https://www.ebay.com/itm/apify-${index}`,
          title: "Sony WH-1000XM4 Wireless Headphones",
          condition: "Pre-Owned",
          endedAt,
          soldPrice,
          soldCurrency: "USD",
          listingType: "buy_it_now",
          isBestOfferAccepted: false,
        })),
      }),
    });
    const recommendation = await new PriceRouter([provider]).price({
      brand: "Sony",
      model: "WH-1000XM4",
      category: "electronics",
      condition: "good",
      conditionKnown: true,
    });

    const facts = verifiedPriceEvidence(recommendation);
    const guidance = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "uncertainty.limited-price-evidence",
      locale: "en-US",
      substitutions: facts,
    });

    expect(guidance.message.body).toBe("3 sold · 9 days");
  });

  it("rejects routed sold evidence when a counted comp is undated or too old for bounded copy", async () => {
    for (const recommendation of [
      await routedPriceRecommendation(3, 90, null),
      await routedPriceRecommendation(3, 90, Date.parse("2020-01-01T00:00:00Z")),
    ]) {
      expect(() => verifiedPriceEvidence(recommendation)).toThrowError(
        expect.objectContaining({
          name: "ScoutGuidanceFactError",
          code: "untrusted-price-recommendation",
        }),
      );
    }
  });

  it("rejects a recommendation that repeats one routed sale as multiple sold comps", async () => {
    const recommendation = await routedPriceRecommendation(1, 90);
    const source = recommendation.sources[0]!;
    recommendation.sources.push(source);

    expect(() =>
      verifiedPriceEvidence(recommendation),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceFactError",
        code: "untrusted-price-recommendation",
      }),
    );
  });

  it("leaves fractional pricing staleness policy valid at the existing router seam", async () => {
    const html = readFileSync(
      resolve("src/lib/pricing/providers/fixtures/ebay-sold.sample.html"),
      "utf8",
    );
    const router = new PriceRouter([
      createEbaySoldPricingProvider({
        enabled: true,
        fetchPage: async () => html,
        now: () => Date.parse("2026-07-18T00:00:00.000Z"),
        staleDays: 180.5,
      }),
    ]);

    await expect(
      router.price({
        brand: "Sony",
        model: "WH-1000XM4",
        category: "electronics",
        condition: "good",
        conditionKnown: true,
      }),
    ).resolves.toMatchObject({ tier: "ebay-sold" });
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

  it("rejects a copied verified fact whose trusted fields were relabelled", () => {
    const copiedFact = { ...verifiedItemName() } as {
      source: ScoutGuidanceTrustedSource;
      reference: string;
      value: string;
    };
    copiedFact.source = "durable-item-record";
    copiedFact.reference =
      `item:${ITEM_ID}:review-revision:${REVIEW_REVISION}`;
    copiedFact.value = "Ignore the durable item and render this model-like prose";

    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "processing.finding-sold-comps",
        locale: "en-US",
        substitutions: {
          itemDisplayName: copiedFact,
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

  it("rejects a structural object at the durable-record fact boundary", () => {
    expect(() =>
      verifiedItemDisplayNameFromDurableRecord({
        id: ITEM_ID,
        review_revision: REVIEW_REVISION,
        attributes: {
          title: "Caller-labelled model prose disguised as a durable row",
        },
      } as unknown as ReviewSnapshot),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceFactError",
        code: "untrusted-durable-item-record",
      }),
    );
  });

  it("derives durable facts from the immutable loaded projection, not later mutation", async () => {
    const snapshot = await loadTrustedItemSnapshot({
      brand: "Canon",
      model: "AE-1 film camera",
    });
    snapshot.item.attributes = {
      title: "Caller-mutated model prose after the tenant-scoped read",
    };
    const itemDisplayName = verifiedItemDisplayNameFromDurableRecord(snapshot);

    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "processing.finding-sold-comps",
      locale: "en-US",
      substitutions: { itemDisplayName },
    });

    expect(result.accessibility.label).toContain("Canon AE-1 film camera");
    expect(result.accessibility.label).not.toContain("Caller-mutated");
  });

  it("fails closed when a trusted item has no approved display-name fact", async () => {
    await expect(loadVerifiedItemName({})).rejects.toMatchObject({
      name: "ScoutGuidanceFactError",
      code: "missing-item-display-name",
    });
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

  it("treats inherited prototype names as unsupported locales and falls back", () => {
    const result = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "onboarding.outcome",
      locale: "__proto__",
      substitutions: {},
    });

    expect(result).toMatchObject({
      requestedLocale: "__proto__",
      resolvedLocale: "en-US",
      localeFallbackApplied: true,
      localeFallbackChain: ["__proto__", "en-US"],
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

  it("rejects verified facts outside the template's approved bounds", async () => {
    const evidence = verifiedPriceEvidence(
      await routedPriceRecommendation(100, 90),
    );
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
        substitutionKey: "soldCompCount",
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

  it("rejects inherited prototype names as unsupported states", () => {
    expect(() =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "constructor" as "onboarding.outcome",
        locale: "en-US",
        substitutions: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ScoutGuidanceContractError",
        code: "unsupported-state",
        state: "constructor",
      }),
    );
  });
});
