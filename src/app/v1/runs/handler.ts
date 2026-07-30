import { verifyToken } from "@clerk/nextjs/server";
import { createConfiguredVerifiedGuestPrincipalResolver } from "@/lib/guest-capability/configured";
import {
  createConfiguredSupabaseListingReviewReader,
  createConfiguredSupabaseListingReviewSaver,
} from "@/lib/listing-review";
import { createInternalGuidedCorrectionCompletionRpcClient } from "@/lib/pipeline/guided-correction-internal";
import {
  createConfiguredSupabaseMobileRunOperations,
  createMobileApiHandler,
} from "@/lib/mobile-api";
import type { PipelineWorker } from "@/lib/pipeline-queue/composition";

const unavailableWorker: PipelineWorker = {
  async consume() {
    throw new Error("The mobile run route has no pipeline-consumer capability.");
  },
};

function configuredRunOperations() {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const cursorSigningSecret = process.env.CLERK_SECRET_KEY?.trim();
  if (!supabaseURL || !anonKey || !cursorSigningSecret) {
    throw new Error("The mobile RLS run adapter is not configured.");
  }
  return createConfiguredSupabaseMobileRunOperations({
    supabaseURL,
    anonKey,
    cursorSigningSecret,
  });
}

function configuredListingReview() {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseURL || !publishableKey) {
    throw new Error("The mobile Listing Review adapter is not configured.");
  }
  return createConfiguredSupabaseListingReviewReader({
    publishableKey,
    supabaseURL,
  });
}

function configuredListingReviewSave() {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseURL || !publishableKey) {
    throw new Error("The mobile Listing Review save adapter is not configured.");
  }
  return createConfiguredSupabaseListingReviewSaver({
    publishableKey,
    supabaseURL,
    completionClient: createInternalGuidedCorrectionCompletionRpcClient(),
  });
}

const handler = createMobileApiHandler({
  async authenticate(token) {
    if (token.startsWith("guestcap_")) {
      const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
      const secretKey = process.env.SUPABASE_SECRET_KEY?.trim()
        || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      const keyId = process.env.SUPABASE_GUEST_JWT_KEY_ID?.trim();
      const privateKeyPem =
        process.env.SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM?.trim();
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
  },
  runOperations: {
    get(input) {
      return configuredRunOperations().get(input);
    },
    retry(input) {
      return configuredRunOperations().retry(input);
    },
    cancel(input) {
      return configuredRunOperations().cancel(input);
    },
  },
  runHistory: {
    list(input) {
      return configuredRunOperations().list(input);
    },
  },
  listingReview: {
    forRun(input) {
      return configuredListingReview().forRun(input);
    },
  },
  listingReviewSave: {
    save(input) {
      return configuredListingReviewSave().save(input);
    },
  },
  worker: unavailableWorker,
});

export function handleMobileRunRequest(request: Request): Promise<Response> {
  return handler(request);
}
