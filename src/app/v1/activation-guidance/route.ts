import { createConfiguredSupabaseActivationGuidanceStore } from "@/lib/activation-guidance/store";
import { createMobileApiHandler } from "@/lib/mobile-api";
import { clerkPrincipal, unavailableWorker } from "../mobile-api-composition";

export const runtime = "nodejs";

function configuredActivationGuidanceStore() {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseURL || !anonKey) return undefined;
  return createConfiguredSupabaseActivationGuidanceStore({ anonKey, supabaseURL });
}

function handler() {
  return createMobileApiHandler({
    activationGuidance: configuredActivationGuidanceStore(),
    authenticate: clerkPrincipal,
    worker: unavailableWorker("activation guidance"),
  });
}

export function GET(request: Request): Promise<Response> {
  return handler()(request);
}

export function POST(request: Request): Promise<Response> {
  return handler()(request);
}
