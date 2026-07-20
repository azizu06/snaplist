import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyToken, createConfiguredSupabasePricingEvidenceReader, forItem } = vi.hoisted(
  () => ({
    verifyToken: vi.fn(),
    createConfiguredSupabasePricingEvidenceReader: vi.fn(),
    forItem: vi.fn(),
  }),
);

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/pricing-evidence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pricing-evidence")>()),
  createConfiguredSupabasePricingEvidenceReader,
}));

import { GET } from "./route";
import { buildPricingEvidenceProjection } from "@/lib/pricing-evidence";

const itemId = "22222222-2222-4222-8222-222222222222";
const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_release";
  verifyToken.mockResolvedValue({ sub: "user_release" });
  forItem.mockResolvedValue({
    item: { id: itemId, title: "Vintage lamp" },
    priceResult: {
      suggested: 30,
      range: { min: 15, max: 45 },
      confidence: 0.25,
      sources: [],
      tier: "llm-only",
    },
    evidenceLevel: "limited",
    evidenceAsOf: "2026-07-19T12:00:00.000Z",
    evidenceAgeDays: 0,
    isStale: false,
    defaultWindow: "90D",
    comparables: [],
    estimatedFees: 4.28,
    estimatedPayout: 25.72,
    chartBounds: null,
  });
  createConfiguredSupabasePricingEvidenceReader.mockReturnValue({ forItem });
});

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  vi.clearAllMocks();
});

describe("production item pricing route composition", () => {
  it("returns a schema-valid zero payout for an authenticated USD 0.01 recommendation", async () => {
    forItem.mockImplementationOnce(async ({ userId, itemId: requestedItemId }) =>
      buildPricingEvidenceProjection(
        {
          run_id: "11111111-1111-4111-8111-111111111111",
          pipeline_run_id: "11111111-1111-4111-8111-111111111111",
          run_kind: "pipeline",
          user_id: userId,
          item_id: requestedItemId,
          prediction_id: "33333333-3333-4333-8333-333333333333",
          listing_id: "44444444-4444-4444-8444-444444444444",
          schema_version: 1,
          item: { title: "One-cent recommendation" },
          price_result: {
            suggested: 0.01,
            range: { min: 0.01, max: 0.01 },
            confidence: 0.1,
            sources: [],
            tier: "llm-only",
          },
          evidence: [],
          evidence_as_of: "2026-07-20T12:00:00+00:00",
          pipeline_runs: {
            id: "11111111-1111-4111-8111-111111111111",
            status: "succeeded",
            stage: "completed",
            listing_id: "44444444-4444-4444-8444-444444444444",
            completed_at: "2026-07-20T12:00:00+00:00",
          },
          listings: {
            id: "44444444-4444-4444-8444-444444444444",
            run_id: "11111111-1111-4111-8111-111111111111",
            item_id: requestedItemId,
            user_id: userId,
          },
        },
        {
          userId,
          itemId: requestedItemId,
          now: Date.parse("2026-07-20T12:00:00.000Z"),
        },
      ),
    );

    const response = await GET(
      new Request(`https://snaplist.example/v1/items/${itemId}/pricing`, {
        headers: { authorization: "Bearer signed-release-jwt" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        priceResult: {
          suggested: 0.01,
          range: { min: 0.01, max: 0.01 },
        },
        estimatedFees: 0.3,
        estimatedPayout: 0,
      },
    });
  });

  it("verifies Clerk then reads only through the bearer-scoped Supabase projection", async () => {
    const response = await GET(
      new Request(`https://snaplist.example/v1/items/${itemId}/pricing`, {
        headers: { authorization: "Bearer signed-release-jwt" },
      }),
    );

    expect(response.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith("signed-release-jwt", {
      secretKey: "sk_test_release",
      authorizedParties: ["https://snaplist.example"],
    });
    expect(createConfiguredSupabasePricingEvidenceReader).toHaveBeenCalledWith({
      supabaseURL: "https://project.supabase.co",
      anonKey: "sb_publishable_release",
    });
    expect(forItem).toHaveBeenCalledWith({
      userId: "user_release",
      bearerToken: "signed-release-jwt",
      itemId,
    });
  });

  it("fails closed before snapshot access when the bearer is invalid", async () => {
    verifyToken.mockRejectedValue(new Error("invalid bearer"));

    const response = await GET(
      new Request(`https://snaplist.example/v1/items/${itemId}/pricing`, {
        headers: { authorization: "Bearer forged" },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
        requestId: expect.any(String),
      },
    });
    expect(forItem).not.toHaveBeenCalled();
  });

  it("returns the documented JSON 401 before verification when authorization is missing", async () => {
    const response = await GET(
      new Request(`https://snaplist.example/v1/items/${itemId}/pricing`),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
        requestId: expect.any(String),
      },
    });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(forItem).not.toHaveBeenCalled();
  });
});
