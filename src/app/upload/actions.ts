"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runPipelineAndPersist } from "@/lib/pipeline";
import { createVisionPipeline } from "@/lib/vision";

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

const ACCEPTED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
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
      `/upload?error=${encodeURIComponent("Unsupported file type. Use PNG, JPEG, WEBP, or HEIC.")}`,
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
    // Real vision pipeline: the user-scoped server client signs the private photo
    // URLs and the same client persists every row under RLS.
    const pipeline = createVisionPipeline({ supabase });
    const res = await runPipelineAndPersist(
      supabase,
      {
        userId: user.id,
        photos: [path],
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
