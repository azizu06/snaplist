import { createClient } from "@supabase/supabase-js";
import { logServerError } from "@/lib/api/errors";
import { serveEbayPhoto } from "@/lib/marketplace/ebay/photo-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ token: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    // Trim each candidate before choosing, matching every other handler: an
    // empty or whitespace-only SUPABASE_SECRET_KEY must fall through to the
    // legacy name rather than winning and failing the configuration check.
    const secretKey = process.env.SUPABASE_SECRET_KEY?.trim()
      || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!supabaseURL || !secretKey) {
      throw new Error("eBay photo access is not configured.");
    }
    const client = createClient(supabaseURL, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { token } = await context.params;
    // `await` inside the try is load-bearing: returning the promise unawaited
    // resolves the try block before the photo read settles, so a Storage
    // outage escapes this catch entirely and eBay receives the framework's
    // default 500 instead of the reported 503 below.
    return await serveEbayPhoto(client, token);
  } catch (error) {
    logServerError("ebay.photo_access", error);
    return new Response("Photo temporarily unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
