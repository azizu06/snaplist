import { verifyToken } from "@clerk/nextjs/server";
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
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseURL || !anonKey) {
    throw new Error("The mobile RLS run adapter is not configured.");
  }
  return createConfiguredSupabaseMobileRunOperations({ supabaseURL, anonKey });
}

const handler = createMobileApiHandler({
  async authenticate(token) {
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
    return { userId };
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
  worker: unavailableWorker,
});

export function handleMobileRunRequest(request: Request): Promise<Response> {
  return handler(request);
}
