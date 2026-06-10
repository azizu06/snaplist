import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Sign out the current user and return to /login. POST (not GET) so it isn't
 * triggered by prefetch/link crawls. Route handlers can write cookies, so the
 * server client's setAll succeeds here (unlike a Server Component).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
