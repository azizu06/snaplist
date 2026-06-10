import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * eBay Marketplace Account Deletion / Closure notification endpoint.
 *
 * Stubbed from day one (PRD: "route stubbed from day one; fully implemented only at
 * the production flip"). It implements the *challenge-code verification* fully (eBay
 * requires this to even save the endpoint) but only STUBS the actual deletion
 * handling — no user data is deleted yet.
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
 * eBay POSTs a signed JSON notification when a user closes their account or requests
 * deletion. Production must verify the message signature and erase that user's data.
 * Stubbed here: we acknowledge (HTTP 200, as eBay requires) and TODO the deletion.
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
  // TODO(production flip): before going live we MUST
  //   1. Verify the notification signature using eBay's public key
  //      (x-ebay-signature header + the Notification API key endpoint) so we only
  //      act on genuine eBay notifications.
  //   2. Parse the payload { metadata, notification: { data: { username, userId,
  //      eiasToken } } } and, using the service-role client, erase that user's
  //      items, listings, messages, embeddings, prediction_logs, and photos
  //      (Storage objects under their `{user_id}/` prefix), or anonymize as policy
  //      requires.
  //   3. Record the deletion for compliance/audit.
  // For now we only acknowledge so the endpoint is reachable and well-formed.
  await request.text().catch(() => undefined); // drain body; ignore contents in the stub

  return NextResponse.json({ received: true }, { status: 200 });
}
