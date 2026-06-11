import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  ACCOUNT_DELETION_TOPIC,
  fetchNotificationPublicKey,
  formatPublicKeyPem,
  parseDeletionNotice,
  parseSignatureHeader,
  primePublicKeyCache,
  verifyNotificationSignature,
} from "./deletion";

/**
 * Offline contract tests for eBay deletion-notice verification: a real ECDSA
 * keypair stands in for eBay's, signing with the exact algorithm the official
 * SDK verifies with ("ssl3-sha1"). No network, no Docker.
 */

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const NOTICE_BODY = JSON.stringify({
  metadata: { topic: ACCOUNT_DELETION_TOPIC, schemaVersion: "1.0" },
  notification: {
    notificationId: "n-1",
    eventDate: "2026-06-12T00:00:00.000Z",
    data: { username: "seller_gone", userId: "EBAYUID-GONE", eiasToken: "tok" },
  },
});

function sign(body: string): string {
  return createSign("ssl3-sha1").update(body).sign(privateKey, "base64");
}

function makeHeader(kid: string, signature: string): string {
  return Buffer.from(JSON.stringify({ kid, signature, alg: "ecdsa" })).toString(
    "base64",
  );
}

describe("parseSignatureHeader", () => {
  it("decodes kid + signature from the base64 JSON header", () => {
    const header = makeHeader("key-1", "c2ln");
    expect(parseSignatureHeader(header)).toEqual({
      kid: "key-1",
      signature: "c2ln",
    });
  });

  it("returns null for garbage, non-JSON, or missing fields", () => {
    expect(parseSignatureHeader("not-base64-json")).toBeNull();
    expect(
      parseSignatureHeader(Buffer.from("{}").toString("base64")),
    ).toBeNull();
    expect(
      parseSignatureHeader(
        Buffer.from(JSON.stringify({ kid: "k" })).toString("base64"),
      ),
    ).toBeNull();
  });
});

describe("verifyNotificationSignature", () => {
  it("accepts a genuine signature over the raw body", () => {
    expect(
      verifyNotificationSignature(NOTICE_BODY, sign(NOTICE_BODY), publicKeyPem),
    ).toBe(true);
  });

  it("rejects a tampered body (signature is over the exact bytes)", () => {
    const tampered = NOTICE_BODY.replace("seller_gone", "someone_else");
    expect(
      verifyNotificationSignature(tampered, sign(NOTICE_BODY), publicKeyPem),
    ).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const forged = createSign("ssl3-sha1")
      .update(NOTICE_BODY)
      .sign(other.privateKey, "base64");
    expect(
      verifyNotificationSignature(NOTICE_BODY, forged, publicKeyPem),
    ).toBe(false);
  });

  it("returns false (never throws) on malformed signature/key material", () => {
    expect(
      verifyNotificationSignature(NOTICE_BODY, "%%%not-base64%%%", "not-a-pem"),
    ).toBe(false);
  });
});

describe("formatPublicKeyPem", () => {
  it("restores the line breaks eBay strips, yielding a Node-usable key", () => {
    const squashed = publicKeyPem
      .replace(/\n/g, "")
      .replace("-----BEGIN PUBLIC KEY-----", "-----BEGIN PUBLIC KEY-----")
      .replace("-----END PUBLIC KEY-----", "-----END PUBLIC KEY-----");
    const restored = formatPublicKeyPem(squashed);
    expect(
      verifyNotificationSignature(NOTICE_BODY, sign(NOTICE_BODY), restored),
    ).toBe(true);
  });
});

describe("fetchNotificationPublicKey", () => {
  it("mints an app token, fetches the key by kid, and caches it", async () => {
    primePublicKeyCache("kid-fetch", null);
    const calls: string[] = [];
    const stubFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/identity/v1/oauth2/token")) {
        const params = new URLSearchParams(String(init?.body));
        expect(params.get("grant_type")).toBe("client_credentials");
        return new Response(JSON.stringify({ access_token: "app-token" }), {
          status: 200,
        });
      }
      expect(url).toContain("/commerce/notification/v1/public_key/kid-fetch");
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer app-token",
      );
      return new Response(
        JSON.stringify({ key: publicKeyPem.replace(/\n/g, "") }),
        { status: 200 },
      );
    };

    const env = { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret" };
    const pem = await fetchNotificationPublicKey("kid-fetch", env, stubFetch);
    expect(
      verifyNotificationSignature(NOTICE_BODY, sign(NOTICE_BODY), pem),
    ).toBe(true);
    expect(calls).toHaveLength(2);

    // Second call: cache hit, no network.
    const again = await fetchNotificationPublicKey("kid-fetch", env, stubFetch);
    expect(again).toBe(pem);
    expect(calls).toHaveLength(2);

    primePublicKeyCache("kid-fetch", null);
  });

  it("names the missing credentials instead of failing opaquely", async () => {
    await expect(fetchNotificationPublicKey("kid-x", {})).rejects.toThrow(
      /EBAY_CLIENT_ID/,
    );
  });
});

describe("parseDeletionNotice", () => {
  it("extracts topic + eBay identity from a deletion notice", () => {
    expect(parseDeletionNotice(NOTICE_BODY)).toEqual({
      topic: ACCOUNT_DELETION_TOPIC,
      username: "seller_gone",
      userId: "EBAYUID-GONE",
    });
  });

  it("tolerates other topics and sparse payloads (acknowledge, don't act)", () => {
    expect(parseDeletionNotice(JSON.stringify({ metadata: { topic: "OTHER" } })))
      .toEqual({ topic: "OTHER", username: undefined, userId: undefined });
    expect(parseDeletionNotice("{}")).toEqual({
      topic: null,
      username: undefined,
      userId: undefined,
    });
  });

  it("returns null for non-JSON", () => {
    expect(parseDeletionNotice("not json")).toBeNull();
  });
});
