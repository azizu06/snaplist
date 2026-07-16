"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { runPipelineAndPersist } from "@/lib/pipeline";
import { parseCostBasis } from "@/lib/pipeline/autopilot";
import { createVisionPipeline } from "@/lib/vision";
import { getAutopilotEnabled, setAutopilotEnabled } from "@/lib/settings/user-settings";
import { reportServerError } from "@/lib/sentry";
import {
  checkDailyItemQuota,
  rateLimitAllows,
  recordPipelineRunAndMaybeAlert,
  refundDailyItem,
} from "@/lib/abuse";
import { resolveNewAiItemRunPolicy } from "@/lib/billing";

/**
 * Upload server action — the spine wired to the request:
 *   1. Require an authenticated user (defense in depth on top of middleware).
 *   2. Store the photo in Supabase Storage under a USER-SCOPED path (`{uid}/...`),
 *      which the storage RLS policy requires.
 *   3. Run the REAL vision pipeline (single multimodal extraction → Zod-validated
 *      attributes + flagged identification) and persist item + listing +
 *      prediction_log via the user-scoped server client (RLS enforced).
 *   4. Redirect to the review page for the created item.
 *
 * The pipeline is injected into `runPipelineAndPersist` (issue #6): the persistence
 * seam is unchanged; only the pipeline behind it became real.
 */

// OpenAI vision input only accepts PNG, JPEG, WEBP, and (non-animated) GIF — NOT
// HEIC/HEIF. Since the upload now feeds the photo straight to the real vision call,
// accepting HEIC/HEIF would store the file and then fail at extraction (the common
// iPhone-default case). Gate to the vision-supported set here; server-side HEIC
// transcoding is a deliberate follow-up.
const ACCEPTED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export async function uploadAndProcess(formData: FormData) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/upload");

  // 1–4 photos (issue #40, Mercari-style slots; PRD: "1 photo required, up to
  // ~4 accepted"). Empty slot inputs submit zero-byte entries — filtered here,
  // so the single-photo path behaves exactly as before.
  const photos = formData
    .getAll("photo")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (photos.length === 0) {
    redirect(`/upload?error=${encodeURIComponent("Choose a photo to upload.")}`);
  }
  if (photos.length > 4) {
    redirect(`/upload?error=${encodeURIComponent("Up to 4 photos per item.")}`);
  }
  for (const photo of photos) {
    if (!ACCEPTED.has(photo.type)) {
      redirect(
        `/upload?error=${encodeURIComponent("Unsupported file type. Use PNG, JPEG, or WEBP (convert HEIC photos first).")}`,
      );
    }
  }

  // Cost basis (#101): the optional "what did you pay" field. Validate BEFORE
  // any storage upload or model spend so a junk value fails fast; blank means
  // unknown (NULL, never a fake $0) and "0" is a real free-find zero.
  let costBasis: number | null = null;
  try {
    costBasis = parseCostBasis(formData.get("costBasis"));
  } catch {
    redirect(
      `/upload?error=${encodeURIComponent("“What did you pay” must be a plain dollar amount (or left blank).")}`,
    );
  }

  // Operational abuse guardrail (#58), independent of subscription entitlement.
  // The server action shares the same per-user bucket as metered API routes.
  if (!(await rateLimitAllows(userId))) {
    redirect(
      `/upload?error=${encodeURIComponent("Too many requests. Please slow down and try again shortly.")}`,
    );
  }

  // #153: one request-scoped, RLS-enforcing server policy owns authorization to
  // begin provider-backed work. No browser/client tier state participates.
  const itemRunPolicy = await resolveNewAiItemRunPolicy(userId, {
    client: supabase,
  });
  if (!itemRunPolicy.allowed) {
    const message =
      itemRunPolicy.reason === "policy-unavailable"
        ? "We couldn't verify whether this item can start. Please try again."
        : "SnapList Pro is required to start another new item.";
    redirect(`/upload?error=${encodeURIComponent(message)}`);
  }

  // Legacy daily capacity remains an operational cost guardrail only. It is
  // deliberately not resolved from entitlement and is not presented as a plan
  // allowance or native credit balance.
  const quota = await checkDailyItemQuota(userId);
  if (!quota.allowed) {
    redirect(
      `/upload?error=${encodeURIComponent("Capacity limit reached. Please try again later.")}`,
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
      // Log the real storage error server-side; show the user a generic message —
      // never leak Supabase internals via the redirect query string (CWE-209, #57).
      reportServerError("upload.store", uploadErr);
      // Give back the daily item slot — the item never persisted (#58 self-review).
      await refundDailyItem(userId);
      redirect(`/upload?error=${encodeURIComponent("Upload failed. Please try again.")}`);
    }
    paths.push(path);
  }

  let itemId: string;
  try {
    // The user's publish-eligibility switch (legacy identifier, issue #12):
    // forwarded into the confidence gate, so when it is off nothing is eligible and every
    // listing stays a draft for review.
    const autopilotEnabled = await getAutopilotEnabled(supabase, userId);

    // Spend guardrail (#58): count this model-backed run toward the global daily
    // OpenAI budget; fires a one-time alert on the first breach (warns, doesn't block).
    await recordPipelineRunAndMaybeAlert();

    // Real vision pipeline: the user-scoped server client signs the private photo
    // URLs and the same client persists every row under RLS.
    const pipeline = createVisionPipeline({ supabase });
    const res = await runPipelineAndPersist(
      supabase,
      {
        userId: userId,
        photos: paths,
        autopilotEnabled,
      },
      pipeline,
    );
    itemId = res.itemId;

    // Persist the capture-time cost basis (#101) on the freshly created item.
    // Best-effort AFTER the pipeline: a failure here must not scrap a
    // successful (paid) run — the seller can still set the cost from review.
    if (costBasis != null) {
      const { error: costErr } = await supabase
        .from("items")
        .update({ cost_basis: costBasis })
        .eq("id", itemId);
      if (costErr) reportServerError("upload.costBasis", costErr, { itemId });
    }
  } catch (err) {
    // Pipeline errors (vision/model/DB) stay server-side; the client gets a
    // generic message (CWE-209, #57).
    reportServerError("upload.process", err);
    // Give back the daily item slot — the partial item row is deleted inside
    // runPipelineAndPersist on failure, so nothing strands as "Processing". The
    // global OpenAI budget counter is NOT refunded: the run may have cost calls.
    await refundDailyItem(userId);
    // Remove the photos we uploaded for this failed run so no orphaned storage
    // objects linger (best-effort; the user-scoped client only touches its own).
    await supabase.storage.from("photos").remove(paths);
    redirect(
      `/upload?error=${encodeURIComponent("We couldn't process that photo. Please try again.")}`,
    );
  }

  // `?new=1` marks this as the fresh-upload landing so the review page knows to
  // consume the pending-upload draft (clear its File[]). Without the flag, opening
  // an EXISTING item's review would wrongly wipe a half-built upload draft.
  redirect(`/review/${itemId}?new=1`);
}

/**
 * Toggle the legacy-named readiness preference. It only controls whether high-
 * confidence runs are marked ready; publishing remains an explicit action. A
 * plain form action posts `enabled` = "true" | "false" and persists per user.
 */
export async function setAutopilotSetting(formData: FormData) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/settings");

  const enabled = formData.get("enabled") === "true";
  try {
    await setAutopilotEnabled(supabase, userId, enabled);
  } catch (err) {
    reportServerError("settings.autopilot", err);
    redirect(
      `/settings?error=${encodeURIComponent("Couldn't update publish eligibility. Please try again.")}`,
    );
  }

  // The switch lives on the Settings surface (issue #40, X-11 — moved out of
  // the upload footer so the readiness consequence can be explained).
  revalidatePath("/settings");
  redirect("/settings");
}
