import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createMobileApiHandler } from "@/lib/mobile-api";
import {
  createEbayAdapterForUser,
  createMobileEbayPublishService,
} from "@/lib/marketplace/ebay";
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

function configuredEbayPublish() {
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim()
    || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!publishableKey || !secretKey?.startsWith("sb_secret_")) return undefined;

  return createMobileEbayPublishService({
    clientForBearer: (bearerToken) =>
      configuredClient(bearerToken, publishableKey),
    completionClientForBearer: (bearerToken) =>
      configuredClient(bearerToken, secretKey),
    adapterFor: (client, completionClient, userId) =>
      createEbayAdapterForUser(client, userId, {
        credentialClient: completionClient,
      }),
  });
}

export function handleMobileEbayPublishRequest(
  request: Request,
): Promise<Response> {
  return createMobileApiHandler({
    authenticate: clerkPrincipal,
    ebayPublish: configuredEbayPublish(),
    worker: unavailableWorker("eBay publish"),
  })(request);
}
