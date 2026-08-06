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
    const secretKey = (
      process.env.SUPABASE_SECRET_KEY
      ?? process.env.SUPABASE_SERVICE_ROLE_KEY
    )?.trim();
    if (!supabaseURL || !secretKey) {
      throw new Error("eBay photo access is not configured.");
    }
    const client = createClient(supabaseURL, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { token } = await context.params;
    return serveEbayPhoto(client, token);
  } catch (error) {
    logServerError("ebay.photo_access", error);
    return new Response("Photo temporarily unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
