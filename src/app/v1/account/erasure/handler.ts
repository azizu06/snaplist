import {
  clerkClient,
  reverificationErrorResponse,
} from "@clerk/nextjs/server";
import { createConfiguredAccountErasureOperations } from "@/lib/account-erasure/configured";
import { createAccountErasureHandler } from "@/lib/account-erasure/http";

function configuredAccountErasureOperations() {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  // No SUPABASE_SERVICE_ROLE_KEY fallback: createConfiguredAccountErasureOperations
  // rejects anything that is not an `sb_secret_` key, so falling back to the
  // legacy variable only turns a clear "not configured" into an opaque one.
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim();
  const revenueCatSecretKey = process.env.REVENUECAT_SECRET_API_KEY?.trim();
  if (!supabaseURL || !secretKey || !clerkSecretKey || !revenueCatSecretKey) {
    throw new Error("The account erasure adapter is not configured.");
  }
  return createConfiguredAccountErasureOperations({
    supabaseURL,
    secretKey,
    clerkSecretKey,
    revenueCatSecretKey,
    revenueCatProjectId: process.env.REVENUECAT_PROJECT_ID?.trim() || undefined,
  });
}

const handler = createAccountErasureHandler({
  async authenticateReverified(request) {
    const secretKey = process.env.CLERK_SECRET_KEY?.trim();
    const authorizedParties = process.env.CLERK_AUTHORIZED_PARTIES?.split(",")
      .map((party) => party.trim())
      .filter(Boolean);
    if (!secretKey || !authorizedParties?.length) {
      throw new Error("The Clerk reverification boundary is not configured.");
    }

    const requestState = await (await clerkClient()).authenticateRequest(request, {
      acceptsToken: "session_token",
      authorizedParties,
    });
    if (!requestState.isAuthenticated) {
      throw new Error("A verified Clerk session is required.");
    }
    const authentication = requestState.toAuth();
    if (!authentication.userId) {
      throw new Error("The verified Clerk session has no subject.");
    }
    if (!authentication.has({ reverification: "strict" })) {
      return reverificationErrorResponse("strict");
    }
    return { userId: authentication.userId };
  },
  erase(input) {
    return configuredAccountErasureOperations().erase(input);
  },
  // Every internal failure here reaches the seller as the same 503 telling them
  // to retry with the same key, which is the right answer for a transient fault
  // and a misleading one for a permanent fault. Without this the two are
  // indistinguishable from the outside and silent from the inside — an erasure
  // that can never succeed looks exactly like one that has not succeeded yet.
  reportError(context, error) {
    console.error(context, error);
  },
});

export function handleAccountErasureRequest(request: Request): Promise<Response> {
  return handler(request);
}
