import { verifyToken } from "@clerk/nextjs/server";
import { createConfiguredVerifiedGuestPrincipalResolver } from "@/lib/guest-capability/configured";
import { GUEST_CAPABILITY_TOKEN_PREFIX } from "@/lib/guest-capability/token-prefix";
import { createConfiguredMobileItemSubmissionOperations } from "@/lib/mobile-item-submission/configured";
import { createMobileItemSubmissionHandler } from "@/lib/mobile-item-submission/http";

function supabaseConfiguration() {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim()
    || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseURL || !publishableKey) {
    throw new Error("The mobile item submission adapter is not configured.");
  }
  return { publishableKey, secretKey, supabaseURL };
}

const handler = createMobileItemSubmissionHandler({
  // #386 owns the terminal deletion proof. Release deployments remain
  // photos-only until the operator deliberately enables this after that gate.
  acceptVoiceContext: () =>
    process.env.MOBILE_VOICE_SUBMISSION_ENABLED?.trim().toLowerCase() === "true",
  reportError(context, error) {
    console.error(`[${context}]`, error);
  },
  itemSubmission: {
    async resolvePrincipal(bearerToken) {
      if (bearerToken.startsWith(GUEST_CAPABILITY_TOKEN_PREFIX)) {
        const { secretKey, supabaseURL } = supabaseConfiguration();
        const keyId = process.env.SUPABASE_GUEST_JWT_KEY_ID?.trim();
        const privateKeyPem = process.env.SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM?.trim();
        if (!secretKey || !keyId || !privateKeyPem) {
          throw new Error("The verified guest authentication boundary is not configured.");
        }
        return createConfiguredVerifiedGuestPrincipalResolver({
          keyId,
          privateKeyPem,
          secretKey,
          supabaseURL,
        }).resolve(bearerToken);
      }
      const secretKey = process.env.CLERK_SECRET_KEY?.trim();
      const authorizedParties = process.env.CLERK_AUTHORIZED_PARTIES?.split(",")
        .map((party) => party.trim())
        .filter(Boolean);
      if (!secretKey || !authorizedParties?.length) {
        throw new Error("The native Clerk verification boundary is not configured.");
      }
      const verified = await verifyToken(bearerToken, { secretKey, authorizedParties });
      const userId = verified.sub?.trim();
      if (!userId) throw new Error("The verified Clerk token has no subject.");
      return { kind: "clerk", userId, bearerToken };
    },
    submit(input) {
      const config = supabaseConfiguration();
      return createConfiguredMobileItemSubmissionOperations({
        supabaseURL: config.supabaseURL,
        publishableKey: config.publishableKey,
        ...(input.principal.kind === "clerk"
          ? { secretKey: config.secretKey }
          : {}),
      }).submit(input);
    },
  },
});

export function handleMobileItemSubmissionRequest(request: Request): Promise<Response> {
  return handler(request);
}
