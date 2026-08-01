import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppleDeviceCheckAdapter } from "./apple-device-check";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function adapterWith(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  overrides?: { environment?: "development" | "production" },
) {
  const requests: { body: unknown; headers: Record<string, string>; url: string }[] =
    [];
  const adapter = createAppleDeviceCheckAdapter({
    environment: overrides?.environment ?? "development",
    async fetch(url, init) {
      const headers = Object.fromEntries(
        new Headers(init?.headers).entries(),
      ) as Record<string, string>;
      requests.push({
        body: JSON.parse(String(init?.body ?? "null")),
        headers,
        url: String(url),
      });
      return respond(String(url), init ?? {});
    },
    keyId: "DCKEYID1234",
    now: () => new Date("2026-07-31T18:00:00.000Z"),
    privateKeyPem,
    teamId: "TEAMID1234",
    transactionId: () => "11111111-2222-3333-4444-555555555555",
  });
  return { adapter, requests };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("Apple DeviceCheck adapter", () => {
  it("reads a clear device and a consumed device from Apple's two bits", async () => {
    const clear = adapterWith(() =>
      json(200, { bit0: false, bit1: false, last_update_time: "2026-07" }),
    );
    await expect(
      clear.adapter.queryTwoBits({ deviceToken: "token-a" }),
    ).resolves.toEqual({ bit0: false, bit1: false, status: "resolved" });

    const consumed = adapterWith(() =>
      json(200, { bit0: true, bit1: false, last_update_time: "2026-06" }),
    );
    await expect(
      consumed.adapter.queryTwoBits({ deviceToken: "token-b" }),
    ).resolves.toEqual({ bit0: true, bit1: false, status: "resolved" });
  });

  it("treats Apple's untouched-device response as a clear device", async () => {
    // A device Apple has never recorded answers 200 with this exact plain text.
    const { adapter } = adapterWith(
      () => new Response("Failed to find bit state", { status: 200 }),
    );
    await expect(adapter.queryTwoBits({ deviceToken: "token" })).resolves.toEqual({
      bit0: false,
      bit1: false,
      status: "resolved",
    });
  });

  it.each([
    [400, "malformed_response"],
    [401, "unauthorized"],
    [429, "throttled"],
    [500, "server_error"],
    [503, "unavailable"],
  ])("reports HTTP %i as ambiguous, never as a clear device", async (status, reason) => {
    const { adapter } = adapterWith(() => new Response("", { status }));
    await expect(adapter.queryTwoBits({ deviceToken: "token" })).resolves.toEqual({
      reason,
      status: "ambiguous",
    });
    await expect(
      adapter.updateTwoBits({ bit0: true, bit1: false, deviceToken: "token" }),
    ).resolves.toEqual({ reason, status: "ambiguous" });
  });

  it("reports a transport failure as ambiguous", async () => {
    const { adapter } = adapterWith(() => {
      throw new Error("socket hang up");
    });
    await expect(adapter.queryTwoBits({ deviceToken: "token" })).resolves.toEqual({
      reason: "timeout",
      status: "ambiguous",
    });
  });

  it("refuses to read an unrecognised 200 body as a clear device", async () => {
    const { adapter } = adapterWith(
      () => new Response("Bits are elsewhere", { status: 200 }),
    );
    await expect(adapter.queryTwoBits({ deviceToken: "token" })).resolves.toEqual({
      reason: "malformed_response",
      status: "ambiguous",
    });
  });

  it("addresses the environment-correct Apple host with a signed ES256 assertion", async () => {
    const development = adapterWith(() => json(200, { bit0: false, bit1: false }));
    await development.adapter.queryTwoBits({ deviceToken: "token" });
    expect(development.requests[0].url).toBe(
      "https://api.development.devicecheck.apple.com/v1/query_two_bits",
    );

    const production = adapterWith(() => json(200, { bit0: false, bit1: false }), {
      environment: "production",
    });
    await production.adapter.updateTwoBits({
      bit0: true,
      bit1: false,
      deviceToken: "token",
    });
    const request = production.requests[0];
    expect(request.url).toBe(
      "https://api.devicecheck.apple.com/v1/update_two_bits",
    );
    expect(request.body).toEqual({
      bit0: true,
      bit1: false,
      device_token: "token",
      timestamp: Date.parse("2026-07-31T18:00:00.000Z"),
      transaction_id: "11111111-2222-3333-4444-555555555555",
    });

    const [header, , signature] = request.headers.authorization
      .replace(/^Bearer /, "")
      .split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "DCKEYID1234",
      typ: "JWT",
    });
    expect(signature.length).toBeGreaterThan(0);
  });

  it("preserves bit1 so the fence never clobbers an unrelated Apple bit", async () => {
    const { adapter, requests } = adapterWith(() => new Response("", { status: 200 }));
    await adapter.updateTwoBits({ bit0: true, bit1: true, deviceToken: "token" });
    expect(requests[0].body).toMatchObject({ bit0: true, bit1: true });
  });
});
