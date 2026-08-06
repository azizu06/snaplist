import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logServerError } from "@/lib/api/errors";
import { createMobileApiHandler } from "@/lib/mobile-api";
import {
  createEbayAdapterForUser,
  createMobileEbayPublishService,
} from "@/lib/marketplace/ebay";
import { createServerRpcClient } from "@/lib/supabase/server-rpc-auth";
import { clerkPrincipal, unavailableWorker } from "./mobile-api-composition";

function configuredClient(
  bearerToken: string,
  apiKey: string,
): SupabaseClient {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!supabaseURL) {
    throw new Error("The mobile eBay Supabase boundary is not configured.");
  }
  return createClient(supabaseURL, apiKey, {
    accessToken: async () => bearerToken,
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function configuredServerRpcClient(
  bearerToken: string,
  apiKey: string,
  serverRpcSecret: string,
): SupabaseClient {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!supabaseURL) {
    throw new Error("The mobile eBay Supabase boundary is not configured.");
  }
  return createServerRpcClient({
    supabaseURL,
    apiKey,
    serverRpcSecret,
    bearerToken,
  });
}

function configuredEbayPublish() {
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim()
    || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const serverRpcSecret = process.env.SERVER_RPC_SECRET?.trim();
  if (
    !publishableKey
    || !secretKey?.startsWith("sb_secret_")
    || !serverRpcSecret
  ) return undefined;

  return createMobileEbayPublishService({
    clientForBearer: (bearerToken) =>
      configuredClient(bearerToken, publishableKey),
    completionClientForBearer: (bearerToken) =>
      configuredServerRpcClient(bearerToken, secretKey, serverRpcSecret),
    adapterFor: (client, completionClient, userId, env) =>
      createEbayAdapterForUser(client, userId, {
        credentialClient: completionClient,
        env: () => env,
      }),
  });
}

export function handleMobileEbayPublishRequest(
  request: Request,
): Promise<Response> {
  return createMobileApiHandler({
    authenticate: clerkPrincipal,
    ebayPublish: configuredEbayPublish(),
    // Every internal failure on this path reaches the native client as the same
    // generic 503. Without this the reporter is optional-chained away, so the
    // failure leaves no trace at all — the response says "temporarily
    // unavailable" and the server says nothing. `logServerError` is the
    // canonical seam the rest of the API reports through; it forwards to Sentry
    // (#62), so the trace lands where failures are actually watched instead of
    // in a console line nobody is paged for.
    reportError: logServerError,
    worker: unavailableWorker("eBay publish"),
  })(request);
}
