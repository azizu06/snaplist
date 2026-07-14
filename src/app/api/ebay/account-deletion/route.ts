import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/observability";
import { eraseEbayUserData } from "@/lib/marketplace/ebay";
import {
  ACCOUNT_DELETION_TOPIC,
  fetchNotificationPublicKey,
  parseDeletionNotice,
  parseSignatureHeader,
  verifyNotificationSignature,
} from "@/lib/marketplace/ebay/deletion";

/**
 * eBay Marketplace Account Deletion / Closure notification endpoint (issue
 * #17). The route is implemented and remains inactive until its production
 * verification token, URL, and eBay subscription are configured.
 *
 * --- GET: endpoint verification (challenge-response) ---
 * eBay calls `GET <endpoint>?challenge_code=...`. We must respond with
 *   { "challengeResponse": sha256_hex(challengeCode + verificationToken + endpoint) }
 * where the three strings are concatenated IN THAT ORDER, hashed with SHA-256, and
 * returned as the lowercase hex digest (NOT base64). The `endpoint` must be the exact
 * URL registered with eBay.
 * Ref: https://developer.ebay.com/marketplace-account-deletion
 *
 * --- POST: deletion notification ---
 * eBay POSTs a signed JSON notice when an eBay user closes their account. The
 * x-ebay-signature header is verified against eBay's notification public key
 * BEFORE anything is acted on; an unverifiable notice is answered 412 so eBay
 * retries/alerts instead of counting a dropped deletion as delivered. A
 * verified notice erases everything held about that eBay user, including
 * seller credentials and buyer-message records, through the serialized
 * generation-safe erasure RPC.
 */

const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;
// The exact endpoint URL registered in the eBay developer console. Must match
// byte-for-byte or the hash eBay computes will differ and verification fails.
const EBAY_DELETION_ENDPOINT_URL = process.env.EBAY_DELETION_ENDPOINT_URL;

/**
 * Pure, testable challenge-response hasher. Exported so the contract can be unit
 * tested without spinning up the route. Order is load-bearing: eBay computes
 * sha256(challengeCode + verificationToken + endpoint).
 */
export function computeChallengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpoint: string,
): string {
  return createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest("hex");
}

export function GET(request: NextRequest) {
  const challengeCode = request.nextUrl.searchParams.get("challenge_code");

  if (!challengeCode) {
    return NextResponse.json(
      { error: "Missing challenge_code query parameter." },
      { status: 400 },
    );
  }

  if (!EBAY_VERIFICATION_TOKEN || !EBAY_DELETION_ENDPOINT_URL) {
    // Misconfiguration — fail loudly rather than returning a wrong hash that would
    // make eBay silently reject the endpoint.
    return NextResponse.json(
      {
        error:
          "Endpoint not configured: set EBAY_VERIFICATION_TOKEN and EBAY_DELETION_ENDPOINT_URL.",
      },
      { status: 500 },
    );
  }

  const challengeResponse = computeChallengeResponse(
    challengeCode,
    EBAY_VERIFICATION_TOKEN,
    EBAY_DELETION_ENDPOINT_URL,
  );

  return NextResponse.json(
    { challengeResponse },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text().catch(() => "");

  // 1. Verify the signature BEFORE trusting a byte of the payload.
  const header = request.headers.get("x-ebay-signature");
  const parsedHeader = header ? parseSignatureHeader(header) : null;
  if (!parsedHeader) {
    return NextResponse.json(
      { error: "Missing or malformed x-ebay-signature header." },
      { status: 412 },
    );
  }

  let verified = false;
  try {
    const publicKeyPem = await fetchNotificationPublicKey(parsedHeader.kid);
    verified = verifyNotificationSignature(
      rawBody,
      parsedHeader.signature,
      publicKeyPem,
    );
  } catch (err) {
    logEvent("ebay.account_deletion.verify_error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Could not verify notification signature." },
      { status: 412 },
    );
  }
  if (!verified) {
    return NextResponse.json(
      { error: "Signature verification failed." },
      { status: 412 },
    );
  }

  // 2. Parse the verified notice; non-deletion topics are acknowledged untouched.
  const notice = parseDeletionNotice(rawBody);
  if (!notice) {
    return NextResponse.json({ error: "Unparseable payload." }, { status: 412 });
  }
  if (notice.topic !== ACCOUNT_DELETION_TOPIC) {
    return NextResponse.json({ received: true }, { status: 200 });
  }

  // 3. Erase what we hold about this eBay user + record it for compliance.
  try {
    const erasedTenants = await eraseEbayUserData(
      createAdminClient(),
      notice.userId,
      notice.username,
    );
    logEvent("ebay.account_deletion", {
      erasedTenants,
    });
  } catch (err) {
    // 500 (not 200) — eBay retries, so a transient DB failure can't silently
    // count as a completed deletion.
    logEvent("ebay.account_deletion.erase_error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erasure failed." }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
