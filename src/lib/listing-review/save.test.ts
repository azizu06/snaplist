import { describe, expect, it, vi } from "vitest";
import {
  createListingReviewSaveDataClient,
  createListingReviewSaveRegenerator,
  createListingReviewSaver,
  ListingReviewIdempotencyConflictError,
  ListingReviewNotEditableError,
  ListingReviewSaveInProgressError,
  ListingReviewStaleError,
  type ListingReviewSaveDataClient,
  type ListingReviewSaveReceipt,
} from "./save";

const runId = "54900000-0000-4000-8000-000000000001";
const itemId = "54900000-0000-4000-8000-000000000002";
const listingId = "54900000-0000-4000-8000-000000000003";
const expectedReviewRevision = "54900000-0000-4000-8000-000000000004";
const idempotencyKey = "54900000-0000-4000-8000-000000000005";

const intent = {
  expectedReviewRevision,
  title: "Sony WH-1000XM4 Wireless Headphones",
  description: "Tested and working.",
  condition: "good" as const,
  specifics: [
    { name: "Brand", value: "Sony" },
    { name: "Model", value: "WH-1000XM4" },
  ],
  sellerPriceOverride: 179.99,
};

const receipt: ListingReviewSaveReceipt = {
  schemaVersion: 1,
  runId,
  itemId,
  listingId,
  reviewRevision: idempotencyKey,
};

const snapshot = {
  itemId,
  attributes: {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
  },
  specifics: {
    Brand: "Sony",
    Model: "WH-1000XM4",
  },
};

const operation = {
  runId,
  idempotencyKey,
  intent,
  userId: "user_549",
  bearerToken: "clerk-token",
};

function dataClient(
  results: Array<
    | { state: "completed"; receipt: ListingReviewSaveReceipt }
    | { state: "regeneration"; snapshot: typeof snapshot }
    | { state: "in_progress" }
  >,
): ListingReviewSaveDataClient {
  return {
    execute: vi.fn(async () => results.shift()!),
    release: vi.fn(async () => undefined),
  };
}

describe("ListingReviewSaver", () => {
  it("returns a completed replay receipt without regeneration", async () => {
    const client = dataClient([{ state: "completed", receipt }]);
    const regenerate = vi.fn();

    await expect(
      createListingReviewSaver(client, { regenerate }).save(operation),
    ).resolves.toEqual(receipt);

    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("regenerates coherently once and finalizes with the same logical key", async () => {
    const client = dataClient([
      { state: "regeneration", snapshot },
      { state: "completed", receipt },
    ]);
    const regenerate = vi.fn();

    await expect(
      createListingReviewSaver(client, { regenerate }).save({
        ...operation,
        intent: { ...intent, condition: "very-good" },
      }),
    ).resolves.toEqual(receipt);

    expect(regenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        idempotencyKey,
        snapshot,
      }),
    );
    expect(client.execute).toHaveBeenCalledTimes(2);
  });

  it("releases failed provider work so the same logical key can retry", async () => {
    const failure = new Error("Pricing provider unavailable.");
    const client = dataClient([{ state: "regeneration", snapshot }]);
    const saver = createListingReviewSaver(client, {
      regenerate: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(saver.save(operation)).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledWith(
      expect.objectContaining({ runId, idempotencyKey }),
    );
  });

  it("maps a stale coherent regeneration to the public stale conflict", async () => {
    const client = dataClient([{ state: "regeneration", snapshot }]);
    const saver = createListingReviewSaver(client, {
      regenerate: vi.fn(async () => {
        throw new Error(
          "Guided correction authorization failed: Review changed. Reload and try again.",
        );
      }),
    });

    await expect(saver.save(operation)).rejects.toBeInstanceOf(
      ListingReviewStaleError,
    );
    expect(client.release).toHaveBeenCalledWith(
      expect.objectContaining({ runId, idempotencyKey }),
    );
  });

  it.each([
    "A published listing cannot be regenerated from review.",
    "Guided correction authorization failed: Editable eBay listing not found.",
  ])("maps the authoritative regeneration race %s", async (message) => {
    const client = dataClient([{ state: "regeneration", snapshot }]);
    const saver = createListingReviewSaver(client, {
      regenerate: vi.fn(async () => {
        throw new Error(message);
      }),
    });

    await expect(saver.save(operation)).rejects.toBeInstanceOf(
      ListingReviewNotEditableError,
    );
  });

  it("normalizes semantic intent before the first database operation", async () => {
    const client = dataClient([{ state: "completed", receipt }]);
    const saver = createListingReviewSaver(client, { regenerate: vi.fn() });

    await saver.save({
      ...operation,
      intent: {
        ...intent,
        title: "  Sony WH-1000XM4 Wireless Headphones ",
        description: " Tested and working. \n",
        specifics: [
          { name: " Brand ", value: " Sony " },
          { name: "Model", value: " WH-1000XM4 " },
        ],
        sellerPriceOverride: 12.345,
      },
    });

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: { ...intent, sellerPriceOverride: 12.35 },
      }),
    );
  });

  it("reports an in-flight duplicate without provider work", async () => {
    const client = dataClient([{ state: "in_progress" }]);
    const regenerate = vi.fn();

    await expect(
      createListingReviewSaver(client, { regenerate }).save(operation),
    ).rejects.toBeInstanceOf(ListingReviewSaveInProgressError);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("mints a fresh guest RLS token for each fixed RPC", async () => {
    const execute = vi.fn().mockResolvedValue({
      data: { state: "completed", receipt },
      error: null,
    });
    const release = vi.fn().mockResolvedValue({
      data: { state: "failed" },
      error: null,
    });
    const clientForBearer = vi
      .fn()
      .mockReturnValueOnce({ rpc: execute })
      .mockReturnValueOnce({ rpc: release });
    const mintOperationToken = vi
      .fn()
      .mockResolvedValueOnce("fresh-guest-save-jwt")
      .mockResolvedValueOnce("fresh-guest-release-jwt");
    const client = createListingReviewSaveDataClient(clientForBearer);
    const guestOperation = {
      ...operation,
      userId: "guest_549",
      bearerToken: "guestcap_opaque",
      mintOperationToken,
    };

    await client.execute(guestOperation);
    await client.release(guestOperation);

    expect(clientForBearer.mock.calls).toEqual([
      ["fresh-guest-save-jwt"],
      ["fresh-guest-release-jwt"],
    ]);
    expect(execute).toHaveBeenCalledWith(
      "save_mobile_listing_review",
      expect.objectContaining({ p_run_id: runId }),
    );
    expect(release).toHaveBeenCalledWith(
      "claim_mobile_listing_review_save",
      expect.objectContaining({ p_action: "fail" }),
    );
  });

  it.each([
    [
      "This review changed. Reload and try again.",
      ListingReviewStaleError,
    ],
    [
      "This Idempotency-Key is already bound to different review edits.",
      ListingReviewIdempotencyConflictError,
    ],
  ])("maps the fixed data error %s", async (message, ErrorType) => {
    const client = createListingReviewSaveDataClient(() => ({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message },
      }),
    }));

    await expect(client.execute(operation)).rejects.toBeInstanceOf(ErrorType);
  });

  it("binds the existing guided-correction run to the idempotency key", async () => {
    const regenerate = vi.fn().mockResolvedValue({});
    const regenerator = createListingReviewSaveRegenerator({
      clientForBearer: vi.fn(() => ({}) as never),
      completionClient: { rpc: vi.fn() },
      regenerate,
    });

    await regenerator.regenerate({
      ...operation,
      intent: {
        ...intent,
        condition: "very-good",
        specifics: [
          { name: "Brand", value: "Sony" },
          { name: "Model", value: "WH-1000XM5" },
        ],
      },
      snapshot,
    });

    const dependencies = regenerate.mock.calls[0]?.[2];
    expect(regenerate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        itemId,
        expectedReviewRevision,
        corrections: expect.objectContaining({
          model: "WH-1000XM5",
          condition: "very-good",
        }),
      }),
      expect.objectContaining({ randomUUID: expect.any(Function) }),
    );
    expect(dependencies?.randomUUID()).toBe(idempotencyKey);
  });

  it("treats staged specifics as a complete identity replacement", async () => {
    const regenerate = vi.fn().mockResolvedValue({});
    const regenerator = createListingReviewSaveRegenerator({
      clientForBearer: vi.fn(() => ({}) as never),
      completionClient: { rpc: vi.fn() },
      regenerate,
    });

    await regenerator.regenerate({
      ...operation,
      intent: {
        ...intent,
        specifics: [
          { name: "Brand", value: "Sony" },
          { name: "Storage Capacity", value: "256 GB" },
        ],
      },
      snapshot: {
        ...snapshot,
        attributes: {
          ...snapshot.attributes,
          isbn: "9780306406157",
          upc: "036000291452",
          specs: ["Storage Capacity: 128 GB", "Color: Black"],
        },
        specifics: {
          Brand: "Sony",
          Model: "WH-1000XM4",
          ISBN: "9780306406157",
          UPC: "036000291452",
          "Storage Capacity": "128 GB",
          Color: "Black",
        },
      },
    });

    expect(regenerate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        corrections: {
          brand: "Sony",
          model: null,
          category: "electronics",
          condition: "good",
          isbn: null,
          upc: null,
          specs: ["Storage Capacity: 256 GB"],
        },
      }),
      expect.any(Object),
    );
  });

  it("passes valid structured specifics through coherent regeneration intact", async () => {
    const regenerate = vi.fn().mockResolvedValue({});
    const regenerator = createListingReviewSaveRegenerator({
      clientForBearer: vi.fn(() => ({}) as never),
      completionClient: { rpc: vi.fn() },
      regenerate,
    });
    const longValue = "x".repeat(130);
    const nonIdentitySpecifics = [
      { name: "Color", value: "Red, White" },
      { name: "Feature 02", value: "Value 02" },
      { name: "Feature 03", value: "Value 03" },
      { name: "Feature 04", value: "Value 04" },
      { name: "Feature 05", value: "Value 05" },
      { name: "Feature 06", value: "Value 06" },
      { name: "Feature 07", value: "Value 07" },
      { name: "Feature 08", value: "Value 08" },
      { name: "Feature 09", value: "Value 09" },
      { name: "Feature 10", value: "Value 10" },
      { name: "Feature 11", value: "Value 11" },
      { name: "Feature 12", value: "Value 12" },
      { name: "Seller Notes", value: longValue },
    ];

    await expect(
      regenerator.regenerate({
        ...operation,
        intent: {
          ...intent,
          specifics: [
            { name: "Brand", value: "Sony" },
            { name: "Model", value: "WH-1000XM4" },
            ...nonIdentitySpecifics,
          ],
        },
        snapshot,
      }),
    ).resolves.toBeUndefined();

    const corrections = regenerate.mock.calls[0]?.[1].corrections;
    expect(corrections.specs).toHaveLength(13);
    expect(corrections.specs[0]).toBe("Color: Red, White");
    expect(corrections.specs[12]).toBe(`Seller Notes: ${longValue}`);
  });
});
