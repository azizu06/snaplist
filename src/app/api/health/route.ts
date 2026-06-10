import { NextResponse } from "next/server";

/** Liveness probe — confirms the app boots and serves. */
export function GET() {
  return NextResponse.json({ ok: true, service: "snaplist" });
}
