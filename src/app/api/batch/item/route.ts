import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { initialListingStatus, runPipelineAndPersist } from "@/lib/pipeline";
import { createVisionPipeline } from "@/lib/vision";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { logServerError, serverErrorJson } from "@/lib/api/errors";
import {
  checkDailyItemQuota,
  enforceRateLimit,
  recordPipelineRunAndMaybeAlert,
  refundDailyItem,
} from "@/lib/abuse";
import { getEntitlement } from "@/lib/billing";

/**
 * POST /api/batch/item — run ONE item of a bulk/haul batch (issue #100)
 * through the EXISTING single-item pipeline spine. This is the upload server
 * action's flow re-exposed as JSON (the batch triage list needs per-item
 * outcomes, not redirects); every guardrail from that path applies unchanged
 * and in the same order:
 *
 *   auth → per-minute rate limit → photo validation → per-user/day item
 *   quota (#58, tier-aware via billing #64) → user-scoped storage upload →
 *   global OpenAI budget counter → `runPipelineAndPersist` (items row +
 *   prediction_logs row + listings row under RLS).
 *
 * The batch client calls this once per item with SMALL bounded concurrency,
 * so these per-run limits stay authoritative for the whole haul. Responses
 * carry a machine-readable `kind` for the two throttle cases so the
 * orchestrator can distinguish "stop dispatching, the day's quota is gone"
 * (`quota`) from "back off and retry" (`rate-limit`).
 */

// Same vision-supported set the single-item upload accepts (HEIC would store
// then fail at extraction).
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_PHOTOS = 4;

export async function POST(request: Request) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Per-minute metered limit — shares the same `user:<id>` bucket as every
  // other metered surface, so a batch can't out-run the single-item path.
  const limited = await enforceRateLimit(request, userId);
  if (limited) {
    // Re-shape with `kind` so the orchestrator can back off + retry instead of
    // treating the throttle as a hard failure. Status/headers are preserved.
    const body = (await limited.json()) as { error?: string };
    return NextResponse.json(
      { ...body, kind: "rate-limit" },
      { status: limited.status, headers: limited.headers },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form body" }, { status: 400 });
  }
  const photos = form
    .getAll("photo")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (photos.length === 0) {
    return NextResponse.json(
      { error: "Each item needs at least one photo." },
      { status: 400 },
    );
  }
  if (photos.length > MAX_PHOTOS) {
    return NextResponse.json(
      { error: `Up to ${MAX_PHOTOS} photos per item.` },
      { status: 400 },
    );
  }
  for (const photo of photos) {
    if (!ACCEPTED.has(photo.type)) {
      return NextResponse.json(
        {
          error:
            "Unsupported file type. Use PNG, JPEG, or WEBP (convert HEIC photos first).",
        },
        { status: 400 },
      );
    }
  }

  // Spend guardrail (#58): the per-user/day ITEM cap, checked BEFORE any
  // storage or model work — exactly as the single-item upload does. A haul
  // that crosses the cap gets `kind: "quota"`, which tells the orchestrator to
  // stop dispatching the rest of the batch (they'd all be denied today).
  const tier = await getEntitlement(userId);
  const quota = await checkDailyItemQuota(userId, undefined, tier);
  if (!quota.allowed) {
    const plan = tier === "paid" ? "Pro" : "free";
    return NextResponse.json(
      {
        error: `Daily limit reached (${quota.limit} items/day on the ${plan} plan). Remaining items will need to wait until tomorrow.`,
        kind: "quota",
        limit: quota.limit,
      },
      { status: 429 },
    );
  }

  // User-scoped object paths: first segment MUST be the user's id (storage policy).
  const paths: string[] = [];
  for (const photo of photos) {
    const ext = photo.name.split(".").pop() ?? "bin";
    const path = `${userId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from("photos")
      .upload(path, photo, { contentType: photo.type, upsert: false });
    if (uploadErr) {
      logServerError("batch.item.store", uploadErr);
      // Give back the daily slot — nothing persisted — and drop any photos
      // already stored for this failed item (best-effort, own objects only).
      await refundDailyItem(userId);
      if (paths.length > 0) await supabase.storage.from("photos").remove(paths);
      return NextResponse.json(
        { error: "Upload failed. Please retry this item." },
        { status: 500 },
      );
    }
    paths.push(path);
  }

  try {
    const autopilotEnabled = await getAutopilotEnabled(supabase, userId);

    // Global daily OpenAI budget counter (warns, doesn't block) — one tick per
    // model-backed run, same as the single-item path.
    await recordPipelineRunAndMaybeAlert();

    const pipeline = createVisionPipeline({ supabase });
    const res = await runPipelineAndPersist(
      supabase,
      { userId, photos: paths, autopilotEnabled },
      pipeline,
    );
    return NextResponse.json({
      itemId: res.itemId,
      listingId: res.listingId,
      // The confidence-gated disposition this run persisted (same derivation
      // `runPipelineAndPersist` used) so the triage row is correct immediately.
      listingStatus: initialListingStatus(res.result.confidence),
    });
  } catch (err) {
    // Pipeline errors stay server-side; the client gets a generic, retryable
    // message (CWE-209, #57). The item row was cleaned up inside
    // runPipelineAndPersist; refund the slot and drop the stored photos.
    await refundDailyItem(userId);
    await supabase.storage.from("photos").remove(paths);
    return serverErrorJson(
      "batch.item.process",
      err,
      "We couldn't process this item. Please retry it.",
    );
  }
}
