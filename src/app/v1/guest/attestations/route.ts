import { enforceAppAttestRateLimit } from "@/lib/abuse";
import { logServerError } from "@/lib/api/errors";
import { createConfiguredGuestClaimHandoff } from "@/lib/app-attest/configured-guest-handoff";

export const runtime = "nodejs";

/** App Attest-backed guest recovery handoff issuance. */
export async function POST(request: Request): Promise<Response> {
  const limited = await enforceAppAttestRateLimit(request);
  if (limited) {
    const headers = new Headers();
    const retryAfter = limited.headers.get("Retry-After");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return Response.json(
      {
        error: {
          code: "rate_limited",
          message: "Too many App Attest requests.",
          requestId: globalThis.crypto.randomUUID(),
        },
      },
      { headers, status: 429 },
    );
  }

  try {
    return createConfiguredGuestClaimHandoff().handleAttestation(request);
  } catch (error) {
    logServerError("mobile-api.guest-attestation.compose", error);
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "Guest attestation is not configured.",
          requestId: globalThis.crypto.randomUUID(),
        },
      },
      { status: 503 },
    );
  }
}
