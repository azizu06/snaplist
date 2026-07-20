import "server-only";

import { createClient } from "@supabase/supabase-js";
import { tierLimits } from "@/lib/abuse/config";
import type { MobileItemSubmissionOperations } from "./contract";
import { createMobileItemSubmissionOperations } from "./service";
import { createSupabaseMobileItemSubmissionStaging } from "./store";

export interface ConfiguredMobileItemSubmissionInput {
  supabaseURL: string;
  publishableKey: string;
  secretKey: string;
}

export function createConfiguredMobileItemSubmissionOperations(
  input: ConfiguredMobileItemSubmissionInput,
): Pick<MobileItemSubmissionOperations, "submit"> {
  if (!input.publishableKey.startsWith("sb_publishable_")) {
    throw new Error("Mobile item submission requires a current Supabase publishable key.");
  }
  if (!input.secretKey.startsWith("sb_secret_")) {
    throw new Error("Mobile item submission requires a current Supabase secret key.");
  }

  const serviceClient = createClient(input.supabaseURL, input.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const limits = tierLimits("free");
  const operations = createMobileItemSubmissionOperations({
    async resolvePrincipal() {
      throw new Error("The configured submission adapter does not authenticate principals.");
    },
    staging: createSupabaseMobileItemSubmissionStaging(serviceClient),
    limits: {
      dailyLimit: limits.itemsPerDay,
      perMinuteLimit: limits.meteredPerMinute,
    },
    storageFor(principal) {
      const tenantClient = createClient(input.supabaseURL, input.publishableKey, {
        accessToken: async () => principal.bearerToken,
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const bucket = tenantClient.storage.from("photos");
      return {
        async upload(path, bytes, mediaType) {
          const { error } = await bucket.upload(path, bytes, {
            contentType: mediaType,
            upsert: false,
          });
          if (error) throw error;
        },
        async download(path) {
          const { data, error } = await bucket.download(path);
          if (error) throw error;
          return {
            bytes: new Uint8Array(await data.arrayBuffer()),
            mediaType: data.type,
          };
        },
      };
    },
  });
  return { submit: operations.submit };
}
