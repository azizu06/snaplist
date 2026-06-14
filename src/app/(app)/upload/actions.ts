"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { runPipelineAndPersist } from "@/lib/pipeline";
import { createVisionPipeline } from "@/lib/vision";
import { getAutopilotEnabled, setAutopilotEnabled } from "@/lib/settings/user-settings";
import { reportServerError } from "@/lib/sentry";

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
      redirect(`/upload?error=${encodeURIComponent("Upload failed. Please try again.")}`);
    }
    paths.push(path);
  }

  let itemId: string;
  try {
    // The user's MASTER autopilot switch (issue #12): forwarded into the pipeline's
    // confidence gate, so when it is off NOTHING is autopilot-eligible and every
    // listing queues as a draft for review.
    const autopilotEnabled = await getAutopilotEnabled(supabase, userId);

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
  } catch (err) {
    // Pipeline errors (vision/model/DB) stay server-side; the client gets a
    // generic message (CWE-209, #57).
    reportServerError("upload.process", err);
    redirect(
      `/upload?error=${encodeURIComponent("We couldn't process that photo. Please try again.")}`,
    );
  }

  redirect(`/review/${itemId}`);
}

/**
 * Toggle the master autopilot switch (issue #12: "autopilot can be turned off
 * entirely"). A plain form action: the form posts `enabled` = "true" | "false";
 * the setting persists per-user in `user_settings` (RLS-scoped upsert) and is
 * read back on every upload before the pipeline runs.
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
      `/settings?error=${encodeURIComponent("Couldn't update autopilot. Please try again.")}`,
    );
  }

  // The switch lives on the Settings surface (issue #40, X-11 — moved out of
  // the upload footer so the auto-publish consequence can be explained).
  revalidatePath("/settings");
  redirect("/settings");
}
