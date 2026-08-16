import { describe, expect, it, vi } from "vitest";
import { createMobileApiHandler, type MobileApiDependencies } from "./app";

/**
 * Issue #890. The transport half of registering a device for push.
 *
 * Two things are load-bearing here. The seller's identity comes from the
 * verified bearer and never from the request body, because a body-supplied id
 * would be a request to write into someone else's tenant. And a guest can
 * register: guest-first is the whole point of the product, and a token stored
 * under a guest identity survives the account claim by the database's own
 * re-key, so refusing guests here would strand exactly the sellers most likely
 * to submit their first item.
 */

const VALID_APNS_TOKEN = "a1b2c3d4".repeat(8);

function handlerWith(overrides: Partial<MobileApiDependencies> = {}) {
  return createMobileApiHandler({
    authenticate: vi
      .fn()
      .mockResolvedValue({ kind: "clerk", userId: "seller_123" }),
    deviceTokens: { register: vi.fn().mockResolvedValue(undefined) },
    requestId: () => "device-token-request",
    worker: { consume: vi.fn() },
    ...overrides,
  });
}

function registration(body: unknown, method = "POST"): Request {
  return new Request("https://snaplist.example/v1/device-tokens", {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: "Bearer signed-seller-token",
      "content-type": "application/json",
    },
    method,
  });
}

describe("mobile device-tokens boundary", () => {
  it("registers the device against the identity the bearer proved", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const response = await handlerWith({ deviceTokens: { register } })(
      registration({ platform: "ios", token: VALID_APNS_TOKEN }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { registered: true },
      meta: { requestId: "device-token-request" },
    });
    expect(register).toHaveBeenCalledWith({
      bearerToken: "signed-seller-token",
      platform: "ios",
      token: VALID_APNS_TOKEN,
      userId: "seller_123",
    });
  });

  it("registers a verified guest with a freshly minted operation token", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const response = await handlerWith({
      authenticate: vi.fn().mockResolvedValue({
        kind: "verifiedGuest",
        mintOperationToken: async () => "minted-guest-jwt",
        userId: "guest_abc",
      }),
      deviceTokens: { register },
    })(registration({ platform: "ios", token: VALID_APNS_TOKEN }));

    expect(response.status).toBe(200);
    // A guest's bearer is an App Attest capability, not a project JWT, so
    // passing it through would be refused by every policy on the table.
    expect(register).toHaveBeenCalledWith({
      bearerToken: "minted-guest-jwt",
      platform: "ios",
      token: VALID_APNS_TOKEN,
      userId: "guest_abc",
    });
  });

  it("refuses a body that tries to name the owner", async () => {
    const register = vi.fn();
    const response = await handlerWith({ deviceTokens: { register } })(
      registration({
        platform: "ios",
        token: VALID_APNS_TOKEN,
        // The client that sent this believed it was choosing the tenant.
        // Answering 200 would be agreeing with it.
        userId: "seller_other",
      }),
    );

    expect(response.status).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses a token that is not a device token", async () => {
    const register = vi.fn();
    const response = await handlerWith({ deviceTokens: { register } })(
      registration({ platform: "ios", token: "not-a-device-token" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses a platform the table cannot store", async () => {
    const register = vi.fn();
    const response = await handlerWith({ deviceTokens: { register } })(
      registration({ platform: "android", token: VALID_APNS_TOKEN }),
    );

    expect(response.status).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });

  it("requires a bearer", async () => {
    const register = vi.fn();
    const response = await handlerWith({ deviceTokens: { register } })(
      new Request("https://snaplist.example/v1/device-tokens", {
        body: JSON.stringify({ platform: "ios", token: VALID_APNS_TOKEN }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses to read a registration", async () => {
    const response = await handlerWith()(registration(undefined, "GET"));

    expect(response.status).toBe(405);
  });

  it("reports a storage failure without inventing a success", async () => {
    const reportError = vi.fn();
    const response = await handlerWith({
      deviceTokens: {
        register: vi.fn().mockRejectedValue(new Error("policy refused")),
      },
      reportError,
    })(registration({ platform: "ios", token: VALID_APNS_TOKEN }));

    expect(response.status).toBe(503);
    // The client treats this as "ask again later"; nothing about the seller's
    // submission depends on it, so the failure stays inside this route.
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "internal_error" },
    });
    expect(reportError).toHaveBeenCalled();
  });

  it("is unavailable rather than silent when the capability is unconfigured", async () => {
    const response = await handlerWith({ deviceTokens: undefined })(
      registration({ platform: "ios", token: VALID_APNS_TOKEN }),
    );

    expect(response.status).toBe(503);
  });
});
