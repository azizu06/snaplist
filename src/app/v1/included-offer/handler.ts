import { verifyToken } from "@clerk/nextjs/server";
import { logServerError } from "@/lib/api/errors";
import { createConfiguredIncludedOfferFence } from "@/lib/included-offer-fence/configured";
import { createMobileApiHandler } from "@/lib/mobile-api";
import type { PipelineWorker } from "@/lib/pipeline-queue/composition";

export const runtime = "nodejs";

const unavailableWorker: PipelineWorker = {
  async consume() {
    throw new Error("The included-offer route has no pipeline-consumer capability.");
  },
};

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : undefined;
}

/**
 * Composed per request rather than at module scope.
 *
 * The account allowance is read through the caller's own RLS identity, so the
 * fence needs that caller's bearer token; a module-scope singleton would have
 * to reach the credit ledger with the service role instead, which is exactly
 * the generic domain authority the redemption path must not hold.
 */
export function handleIncludedOfferRequest(request: Request): Promise<Response> {
  let includedOffer;
  try {
    includedOffer = createConfiguredIncludedOfferFence(process.env, {
      accessToken: bearerToken(request),
    }).fence;
  } catch (error) {
    // Leave it undefined: the handler answers 503 rather than letting an
    // unfenced included run through. The caller learns nothing beyond
    // "unavailable", but a misconfigured credential must not be silent to us.
    logServerError("included-offer.compose", error);
    includedOffer = undefined;
  }

  return createMobileApiHandler({
    async authenticate(token) {
      const secretKey = process.env.CLERK_SECRET_KEY?.trim();
      const authorizedParties = process.env.CLERK_AUTHORIZED_PARTIES?.split(",")
        .map((party) => party.trim())
        .filter(Boolean);
      if (!secretKey || !authorizedParties?.length) {
        throw new Error("The native Clerk verification boundary is not configured.");
      }
      const verified = await verifyToken(token, { secretKey, authorizedParties });
      const userId = verified.sub?.trim();
      if (!userId) throw new Error("The verified Clerk token has no subject.");
      // The included offer is an authenticated-account promotion; #332 guests
      // are fenced by their own App Attest-backed allowance instead.
      return { kind: "clerk" as const, userId };
    },
    includedOffer,
    worker: unavailableWorker,
  })(request);
}
