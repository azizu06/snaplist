"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runPipelineAndPersist } from "@/lib/pipeline";
import { createVisionPipeline } from "@/lib/vision";
import { getAutopilotEnabled, setAutopilotEnabled } from "@/lib/settings/user-settings";

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/upload");

  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    redirect(`/upload?error=${encodeURIComponent("Choose a photo to upload.")}`);
  }
  const photo = file as File;
  if (!ACCEPTED.has(photo.type)) {
    redirect(
      `/upload?error=${encodeURIComponent("Unsupported file type. Use PNG, JPEG, or WEBP (convert HEIC photos first).")}`,
    );
  }

  // User-scoped object path: first segment MUST be the user's id (storage policy).
  const ext = photo.name.split(".").pop() ?? "bin";
  const path = `${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from("photos")
    .upload(path, photo, { contentType: photo.type, upsert: false });
  if (uploadErr) {
    redirect(`/upload?error=${encodeURIComponent(`Upload failed: ${uploadErr.message}`)}`);
  }

  let itemId: string;
  try {
    // The user's MASTER autopilot switch (issue #12): forwarded into the pipeline's
    // confidence gate, so when it is off NOTHING is autopilot-eligible and every
    // listing queues as a draft for review.
    const autopilotEnabled = await getAutopilotEnabled(supabase, user.id);

    // Real vision pipeline: the user-scoped server client signs the private photo
    // URLs and the same client persists every row under RLS.
    const pipeline = createVisionPipeline({ supabase });
    const res = await runPipelineAndPersist(
      supabase,
      {
        userId: user.id,
        photos: [path],
        autopilotEnabled,
      },
      pipeline,
    );
    itemId = res.itemId;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Processing failed.";
    redirect(`/upload?error=${encodeURIComponent(message)}`);
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/upload");

  const enabled = formData.get("enabled") === "true";
  try {
    await setAutopilotEnabled(supabase, user.id, enabled);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update autopilot.";
    redirect(`/upload?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/upload");
  redirect("/upload");
}
