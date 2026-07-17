import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";

/**
 * Retired request-bound batch pipeline.
 *
 * A synchronous per-item request cannot own the #168 logical-run reservation
 * across crash recovery and redelivery. Current clients must stage the whole
 * batch through /api/batch/enqueue, whose database transaction reserves credits
 * and creates durable pipeline runs before any provider-backed worker attempt.
 */
export async function POST() {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      error: "This legacy batch endpoint has been retired. Start the batch again.",
      kind: "gone",
      replacement: "/api/batch/enqueue",
    },
    { status: 410 },
  );
}
