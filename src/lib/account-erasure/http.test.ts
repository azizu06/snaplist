import { describe, expect, it, vi } from "vitest";
import { createAccountErasureHandler } from "./http";
import { AccountErasureIdempotencyConflictError } from "./store";

const idempotencyKey = "38420000-0000-4000-8000-000000000001";
const generationId = "38420000-0000-4000-8000-000000000002";

function request(headers: HeadersInit = {}): Request {
  return new Request("https://snaplist.example/v1/account/erasure", {
    method: "POST",
    headers: {
      "idempotency-key": idempotencyKey,
      ...headers,
    },
  });
}

describe("account erasure HTTP boundary", () => {
  it("returns durable unfinished truth without exposing the manifest or identity", async () => {
    const erase = vi.fn().mockResolvedValue({
      generationId,
      status: "deletion_in_progress",
      retainedRecords: [],
      deferrals: ["ebay-provider-authority-pending"],
      attentionReasons: [],
      identity: { clerkUserId: "user_384", revenueCatAppUserIds: ["rc_384"] },
      storageObjects: [{ bucketId: "photos", objectName: "user_384/private.jpg" }],
    });
    const handler = createAccountErasureHandler({
      authenticateReverified: vi.fn().mockResolvedValue({ userId: "user_384" }),
      erase,
      requestId: () => "request-384",
    });

    const response = await handler(request());

    expect(response.status).toBe(202);
    expect(erase).toHaveBeenCalledWith({ userId: "user_384", idempotencyKey });
    const body = await response.json();
    expect(body).toEqual({
      data: {
        generationId,
        status: "deletion_in_progress",
        retainedRecords: [],
        deferrals: ["ebay-provider-authority-pending"],
        attentionReasons: [],
      },
      meta: { requestId: "request-384" },
    });
    expect(JSON.stringify(body)).not.toContain("private.jpg");
    expect(JSON.stringify(body)).not.toContain("rc_384");
  });

  it("answers 200 only for a terminal status, and keeps the two apart", async () => {
    function handlerFor(status: string, retainedRecords: string[] = []) {
      return createAccountErasureHandler({
        authenticateReverified: vi.fn().mockResolvedValue({ userId: "user_384" }),
        erase: vi.fn().mockResolvedValue({
          generationId,
          status,
          retainedRecords,
          deferrals: [],
          attentionReasons: status === "deletion_needs_attention"
            ? ["clerk-identity-deletion-unverified"]
            : [],
          identity: null,
          storageObjects: [],
        }),
        requestId: () => "request-384",
      });
    }

    await expect(handlerFor("deletion_completed")(request()))
      .resolves.toMatchObject({ status: 200 });

    const retained = await handlerFor(
      "deletion_completed_with_retained_records",
      ["ebay-live-listing"],
    )(request());
    expect(retained.status).toBe(200);
    // The retained-records status must survive the transport intact: a client
    // that saw a flat `deletion_completed` here would be told SnapList deleted
    // a record it never owned.
    expect(await retained.json()).toMatchObject({
      data: {
        status: "deletion_completed_with_retained_records",
        retainedRecords: ["ebay-live-listing"],
      },
    });

    await expect(handlerFor("deletion_needs_attention")(request()))
      .resolves.toMatchObject({ status: 202 });
  });

  it("passes through the Clerk reverification challenge without starting erasure", async () => {
    const erase = vi.fn();
    const challenge = new Response(JSON.stringify({
      clerk_error: { type: "forbidden", reason: "reverification-error" },
    }), { status: 403 });
    const handler = createAccountErasureHandler({
      authenticateReverified: vi.fn().mockResolvedValue(challenge),
      erase,
    });

    const response = await handler(request());

    expect(response).toBe(challenge);
    expect(erase).not.toHaveBeenCalled();
  });

  it("requires a UUID Idempotency-Key before any deletion capability runs", async () => {
    const authenticateReverified = vi.fn();
    const erase = vi.fn();
    const handler = createAccountErasureHandler({ authenticateReverified, erase });

    const response = await handler(request({ "idempotency-key": "not-a-uuid" }));

    expect(response.status).toBe(400);
    expect(authenticateReverified).not.toHaveBeenCalled();
    expect(erase).not.toHaveBeenCalled();
  });

  it("returns a stable conflict when another key already owns the generation", async () => {
    const handler = createAccountErasureHandler({
      authenticateReverified: vi.fn().mockResolvedValue({ userId: "user_384" }),
      erase: vi.fn().mockRejectedValue(new AccountErasureIdempotencyConflictError()),
      requestId: () => "request-conflict",
    });

    const response = await handler(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "conflict",
        message: "The Idempotency-Key is already bound to another account erasure.",
        requestId: "request-conflict",
      },
    });
  });
});
