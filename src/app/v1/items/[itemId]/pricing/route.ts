import { verifyToken } from "@clerk/nextjs/server";
import { createMobileApiHandler } from "@/lib/mobile-api";
import { createConfiguredSupabasePricingEvidenceReader } from "@/lib/pricing-evidence";
import type { PipelineWorker } from "@/lib/pipeline-queue/composition";

export const runtime = "nodejs";

const unavailableWorker: PipelineWorker = {
  async consume() {
    throw new Error("The pricing route has no pipeline-consumer capability.");
  },
};

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
  pricingEvidence: {
    async forItem(input) {
      const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
      if (!supabaseURL || !anonKey) {
        throw new Error("The pricing evidence RLS projection is not configured.");
      }
      return createConfiguredSupabasePricingEvidenceReader({
        supabaseURL,
        anonKey,
      }).forItem(input);
    },
  },
  worker: unavailableWorker,
});

/** Native bearer-authenticated immutable pricing-evidence snapshot. */
export function GET(request: Request): Promise<Response> {
  return handler(request);
}
