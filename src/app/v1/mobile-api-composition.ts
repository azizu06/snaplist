import { verifyToken } from "@clerk/nextjs/server";
import { logServerError } from "@/lib/api/errors";
import {
  createSupabaseNativeSubscriptionBridge,
  resolveRevenueCatServerConfig,
  type NativeSubscriptionBridge,
} from "@/lib/billing";
import type { MobileApiPrincipal } from "@/lib/mobile-api";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PipelineWorker } from "@/lib/pipeline-queue/composition";

/**
 * Composition shared by the mobile API route files that hold no capability of
 * their own beyond a verified Clerk identity. Transport policy and every
 * response shape stay in `src/lib/mobile-api/app.ts`; this module only resolves
 * the runtime adapters that handler asks for.
 */

/** Routes that are not the pipeline-consumer seam still have to satisfy its type. */
export function unavailableWorker(routeName: string): PipelineWorker {
  return {
    async consume() {
      throw new Error(`The ${routeName} route has no pipeline-consumer capability.`);
    },
  };
}

/** Verifies the native bearer against Clerk and returns the RLS identity. */
export async function clerkPrincipal(token: string): Promise<MobileApiPrincipal> {
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
  return { kind: "clerk" as const, userId };
}

/**
 * Composed per request, like the included-offer fence: `createAdminClient()`
 * throws when the service-role credential is absent, and a module-scope
 * singleton would turn that into an import-time crash on every path the file
 * serves.
 *
 * A `null` RevenueCat config is not a failure — the bridge answers `configured:
 * false` / `unconfigured`, which is the honest state before the provider is
 * activated. Only a genuine composition failure returns undefined, which makes
 * the handler answer 503 rather than report an entitlement it never verified.
 */
export function configuredSubscriptionBridge(): NativeSubscriptionBridge | undefined {
  try {
    return createSupabaseNativeSubscriptionBridge(
      createAdminClient(),
      resolveRevenueCatServerConfig(),
    );
  } catch (error) {
    logServerError("mobile-api.subscription-bridge.compose", error);
    return undefined;
  }
}
