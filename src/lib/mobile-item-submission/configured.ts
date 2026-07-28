import "server-only";

import { createClient } from "@supabase/supabase-js";
import { tierLimits } from "@/lib/abuse/config";
import type { MobileItemSubmissionOperations } from "./contract";
import { createMobileItemSubmissionOperations } from "./service";
import { createSupabaseMobileItemSubmissionStaging } from "./store";

export interface ConfiguredMobileItemSubmissionInput {
  supabaseURL: string;
  publishableKey: string;
  secretKey?: string;
}

export function createConfiguredMobileItemSubmissionOperations(
  input: ConfiguredMobileItemSubmissionInput,
): Pick<MobileItemSubmissionOperations, "submit"> {
  if (!input.publishableKey.startsWith("sb_publishable_")) {
    throw new Error("Mobile item submission requires a current Supabase publishable key.");
  }
  if (input.secretKey && !input.secretKey.startsWith("sb_secret_")) {
    throw new Error("Mobile item submission requires a current Supabase secret key.");
  }

  let clerkStaging: ReturnType<typeof createSupabaseMobileItemSubmissionStaging> | undefined;
  function serviceStaging() {
    if (clerkStaging) return clerkStaging;
    if (!input.secretKey?.startsWith("sb_secret_")) {
      throw new Error("Mobile item submission requires a current Supabase secret key.");
    }
    const serviceClient = createClient(input.supabaseURL, input.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clerkStaging = createSupabaseMobileItemSubmissionStaging(serviceClient);
    return clerkStaging;
  }
  function tenantClient(
    accessToken: () => Promise<string>,
  ) {
    return createClient(input.supabaseURL, input.publishableKey, {
      accessToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  const limits = tierLimits("free");
  const operations = createMobileItemSubmissionOperations({
    async resolvePrincipal() {
      throw new Error("The configured submission adapter does not authenticate principals.");
    },
    staging: {
      async findSubmission() {
        throw new Error("A submission principal must select staging authority.");
      },
      async beginSubmission() {
        throw new Error("A submission principal must select staging authority.");
      },
      async commitSubmission() {
        throw new Error("A submission principal must select staging authority.");
      },
      async resolveCleanupIntent() {
        throw new Error("A submission principal must select staging authority.");
      },
    },
    stagingFor(principal) {
      if (principal.kind === "clerk") return serviceStaging();
      return createSupabaseMobileItemSubmissionStaging(
        tenantClient(principal.mintOperationToken),
        { authority: "authenticated-self" },
      );
    },
    limits: {
      dailyLimit: limits.itemsPerDay,
      perMinuteLimit: limits.meteredPerMinute,
    },
    storageFor(principal) {
      const client = tenantClient(
        principal.kind === "clerk"
          ? async () => principal.bearerToken
          : principal.mintOperationToken,
      );
      const bucket = client.storage.from("photos");
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
        async remove(paths) {
          const { error } = await bucket.remove(paths);
          if (error) throw error;
        },
      };
    },
  });
  return { submit: operations.submit };
}
