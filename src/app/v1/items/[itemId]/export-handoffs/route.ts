import { createMobileApiHandler } from "@/lib/mobile-api";
import { createConfiguredAssistedExportGateway } from "@/lib/export/handoff-gateway";
import type { AssistedExportHandoffGateway } from "@/lib/mobile-api";
import { clerkPrincipal, unavailableWorker } from "../../../mobile-api-composition";

export const runtime = "nodejs";

/**
 * Composed per request rather than at module scope: a missing Supabase
 * configuration must answer 503 on the one route that needs it, not crash the
 * import for every path this file serves.
 */
function assistedExportGateway(): AssistedExportHandoffGateway | undefined {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseURL || !anonKey) return undefined;
  return createConfiguredAssistedExportGateway({ supabaseURL, anonKey });
}

function handle(request: Request): Promise<Response> {
  return createMobileApiHandler({
    authenticate: clerkPrincipal,
    assistedExport: assistedExportGateway(),
    worker: unavailableWorker("export handoffs"),
  })(request);
}

/** The three assisted destinations for one prepared pack revision. */
export function GET(request: Request): Promise<Response> {
  return handle(request);
}

/**
 * The seller's own handoff, confirmation, or undo. Facebook Marketplace,
 * Mercari, and Depop are assisted destinations SnapList cannot observe, so no
 * method here ever reports that a listing was published, listed, or sold.
 */
export function POST(request: Request): Promise<Response> {
  return handle(request);
}
