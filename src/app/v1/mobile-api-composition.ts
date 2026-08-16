import { verifyToken } from "@clerk/nextjs/server";
import { logServerError } from "@/lib/api/errors";
import { createConfiguredGuestClaimHandoff } from "@/lib/app-attest/configured-guest-handoff";
import { getClerkAuthorizedParties } from "@/lib/env";
import { createConfiguredVerifiedGuestPrincipalResolver } from "@/lib/guest-capability/configured";
import { GUEST_CAPABILITY_TOKEN_PREFIX } from "@/lib/guest-capability/token-prefix";
import {
  createSupabaseNativeSubscriptionBridge,
  resolveRevenueCatServerConfig,
  type NativeSubscriptionBridge,
} from "@/lib/billing";
import type { MobileApiPrincipal } from "@/lib/mobile-api";
import type { VerifiedGuestHandoff } from "@/lib/guest-recovery";
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
  const authorizedParties = getClerkAuthorizedParties();
  if (!secretKey || !authorizedParties.length) {
    throw new Error("The native Clerk verification boundary is not configured.");
  }
  const verified = await verifyToken(token, { secretKey, authorizedParties });
  const userId = verified.sub?.trim();
  if (!userId) throw new Error("The verified Clerk token has no subject.");
  return { kind: "clerk" as const, userId };
}

/**
 * Resolves either kind of native caller (#890).
 *
 * A guest bearer is an App Attest capability, not a project JWT, so the
 * resolver hands back a principal that can mint one operation token per RLS
 * write. Routes that a guest must be able to reach compose this instead of
 * `clerkPrincipal`, which would reject the guest's bearer as an unverifiable
 * Clerk token.
 */
export async function guestOrClerkPrincipal(
  token: string,
): Promise<MobileApiPrincipal> {
  if (!token.startsWith(GUEST_CAPABILITY_TOKEN_PREFIX)) {
    return clerkPrincipal(token);
  }
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey =
    process.env.SUPABASE_SECRET_KEY?.trim()
    || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const keyId = process.env.SUPABASE_GUEST_JWT_KEY_ID?.trim();
  const privateKeyPem = process.env.SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM?.trim();
  if (!supabaseURL || !secretKey || !keyId || !privateKeyPem) {
    throw new Error(
      "The verified guest authentication boundary is not configured.",
    );
  }
  return createConfiguredVerifiedGuestPrincipalResolver({
    keyId,
    privateKeyPem,
    secretKey,
    supabaseURL,
  }).resolve(token);
}

/** Concrete #610 dependency for the #593 guest-claim route composition. */
export async function verifyGuestClaimHandoff(
  token: string,
): Promise<VerifiedGuestHandoff> {
  return createConfiguredGuestClaimHandoff().verifyGuestClaimHandoff(token);
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
