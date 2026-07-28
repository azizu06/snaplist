import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { SubmissionPrincipal } from "@/lib/mobile-item-submission/contract";
import { createVerifiedGuestCapabilityService } from "./service";
import { createVerifiedGuestOperationTokenSigner } from "./signer";
import { createSupabaseVerifiedGuestCapabilityStore } from "./supabase-store";

export function createConfiguredVerifiedGuestPrincipalResolver(input: {
  keyId: string;
  privateKeyPem: string;
  secretKey: string;
  supabaseURL: string;
}): {
  resolve(bearerToken: string): Promise<Extract<
    SubmissionPrincipal,
    { kind: "verifiedGuest" }
  >>;
} {
  if (!input.secretKey.startsWith("sb_secret_")) {
    throw new Error("Verified guest resolution requires a current Supabase secret key.");
  }
  const metadataClient = createClient(input.supabaseURL, input.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const capabilityService = createVerifiedGuestCapabilityService({
    store: createSupabaseVerifiedGuestCapabilityStore(metadataClient),
  });
  const signer = createVerifiedGuestOperationTokenSigner({
    keyId: input.keyId,
    privateKeyPem: input.privateKeyPem,
    supabaseURL: input.supabaseURL,
  });

  return {
    async resolve(bearerToken) {
      const authority = await capabilityService.resolve(bearerToken);
      return {
        capabilityId: authority.capabilityId,
        kind: "verifiedGuest",
        mintOperationToken: async () => {
          const currentAuthority = await capabilityService.resolve(bearerToken);
          return (await signer).sign(currentAuthority);
        },
        userId: authority.userId,
      };
    },
  };
}
