import { verifyToken } from "@clerk/nextjs/server";
import { createMobileApiHandler } from "@/lib/mobile-api";
import { createConfiguredMobileEbayOauthOperations } from "@/lib/marketplace/ebay/mobile-oauth-store";
import type { PipelineWorker } from "@/lib/pipeline-queue/composition";

const unavailableWorker: PipelineWorker = {
  async consume() {
    throw new Error("The eBay OAuth routes have no pipeline-consumer capability.");
  },
};

function configuredOperations() {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim()
    || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const serverRpcSecret = process.env.SERVER_RPC_SECRET?.trim();
  if (!supabaseURL || !secretKey || !serverRpcSecret) {
    throw new Error("The mobile eBay OAuth store is not configured.");
  }
  return createConfiguredMobileEbayOauthOperations({
    supabaseURL,
    secretKey,
    serverRpcSecret,
  });
}

const handler = createMobileApiHandler({
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
    return { userId };
  },
  ebayOauth: {
    createSession(input) {
      return configuredOperations().createSession(input);
    },
    completeCallback(input) {
      return configuredOperations().completeCallback(input);
    },
  },
  worker: unavailableWorker,
});

export function handleMobileEbayOauthRequest(request: Request): Promise<Response> {
  return handler(request);
}
