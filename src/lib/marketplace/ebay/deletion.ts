import { createVerify } from "node:crypto";
import { z } from "zod";
import { EbayApiError } from "./types";
import { ebayApiBaseUrl } from "./oauth";

/**
 * eBay Marketplace Account Deletion notification handling (issue #17) — the
 * verification + parsing half. The route owns HTTP; this module owns crypto
 * and shapes, so both are testable offline.
 *
 * eBay signs every notification: the `x-ebay-signature` header is base64 of
 * { "kid": <public key id>, "signature": <base64 ECDSA sig>, ... } and the
 * signature is verified over the RAW request body with the public key fetched
 * from GET /commerce/notification/v1/public_key/{kid} (an app-token call).
 * Algorithm pinned to "ssl3-sha1" — exactly what eBay's official
 * event-notification-nodejs-sdk uses; for ECDSA it is equivalent to SHA-1.
 * An unverifiable notification is answered 412 so eBay retries/alerts instead
 * of treating a dropped deletion as delivered.
 */

const VERIFY_ALGORITHM = "ssl3-sha1";

const signatureHeaderSchema = z.object({
  kid: z.string().min(1),
  signature: z.string().min(1),
});

export interface ParsedSignatureHeader {
  kid: string;
  signature: string;
}

/** Decode + validate the x-ebay-signature header. Null = malformed. */
export function parseSignatureHeader(
  header: string,
): ParsedSignatureHeader | null {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(header, "base64").toString("utf8"),
    );
    const parsed = signatureHeaderSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * eBay returns the PEM squashed onto one line ("-----BEGIN PUBLIC KEY-----MFkw…
 * -----END PUBLIC KEY-----"); Node's crypto wants real line breaks around the
 * base64 body. (Same reformatting the official SDK does.)
 */
export function formatPublicKeyPem(raw: string): string {
  return raw
    .replace("-----BEGIN PUBLIC KEY-----", "-----BEGIN PUBLIC KEY-----\n")
    .replace("-----END PUBLIC KEY-----", "\n-----END PUBLIC KEY-----");
}

/** Verify the notification signature over the RAW body. */
export function verifyNotificationSignature(
  rawBody: string,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    return createVerify(VERIFY_ALGORITHM)
      .update(rawBody)
      .verify(publicKeyPem, signatureBase64, "base64");
  } catch {
    return false;
  }
}

/** Module-level cache: eBay rotates keys rarely; one fetch per kid per process. */
const publicKeyCache = new Map<string, string>();

type Env = Record<string, string | undefined>;

/**
 * Fetch (and cache) the notification public key for a kid. Needs an
 * APPLICATION token (client-credentials grant) — deletion notices are
 * app-level, not seller-level.
 */
export async function fetchNotificationPublicKey(
  kid: string,
  env: Env = process.env,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string> {
  const cached = publicKeyCache.get(kid);
  if (cached) return cached;

  const clientId = env.EBAY_CLIENT_ID;
  const clientSecret = env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Cannot verify eBay notifications: set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.",
    );
  }

  const base = ebayApiBaseUrl(env);
  const tokenRes = await fetchImpl(`${base}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }).toString(),
  });
  const tokenBody: unknown = await tokenRes.json().catch(() => undefined);
  if (!tokenRes.ok) {
    throw new EbayApiError(
      `eBay app-token grant failed (HTTP ${tokenRes.status})`,
      tokenRes.status,
      tokenBody,
    );
  }
  const appToken = (tokenBody as { access_token?: string } | undefined)
    ?.access_token;
  if (!appToken) {
    throw new EbayApiError(
      "eBay app-token grant returned no access_token",
      tokenRes.status,
      tokenBody,
    );
  }

  const keyRes = await fetchImpl(
    `${base}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
    { headers: { authorization: `Bearer ${appToken}` } },
  );
  const keyBody: unknown = await keyRes.json().catch(() => undefined);
  if (!keyRes.ok) {
    throw new EbayApiError(
      `eBay public-key fetch failed (HTTP ${keyRes.status})`,
      keyRes.status,
      keyBody,
    );
  }
  const rawKey = (keyBody as { key?: string } | undefined)?.key;
  if (!rawKey) {
    throw new EbayApiError(
      "eBay public-key response had no key",
      keyRes.status,
      keyBody,
    );
  }

  const pem = formatPublicKeyPem(rawKey);
  publicKeyCache.set(kid, pem);
  return pem;
}

/** Test seam: pre-seed/clear the key cache without network. */
export function primePublicKeyCache(kid: string, pem: string | null): void {
  if (pem === null) publicKeyCache.delete(kid);
  else publicKeyCache.set(kid, pem);
}

export const ACCOUNT_DELETION_TOPIC = "MARKETPLACE_ACCOUNT_DELETION";

const deletionNoticeSchema = z.object({
  metadata: z.object({ topic: z.string() }).optional(),
  notification: z
    .object({
      data: z
        .object({
          username: z.string().optional(),
          userId: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface DeletionNotice {
  topic: string | null;
  username: string | undefined;
  userId: string | undefined;
}

/** Parse the (already verified) notification body. Null = not even JSON. */
export function parseDeletionNotice(rawBody: string): DeletionNotice | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = deletionNoticeSchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    topic: parsed.data.metadata?.topic ?? null,
    username: parsed.data.notification?.data?.username,
    userId: parsed.data.notification?.data?.userId,
  };
}
