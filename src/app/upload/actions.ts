"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runPipelineAndPersist } from "@/lib/pipeline";

/**
 * Upload server action — the walking-skeleton spine wired to the request:
 *   1. Require an authenticated user (defense in depth on top of middleware).
 *   2. Store the photo in Supabase Storage under a USER-SCOPED path (`{uid}/...`),
 *      which the storage RLS policy requires.
 *   3. Run the (stubbed) pipeline and persist item + listing + prediction_log via
 *      the user-scoped server client (RLS enforced).
 *   4. Redirect to the review page for the created item.
 *
 * All AI is stubbed behind `runPipelineAndPersist`'s injected pipeline; this action
 * does not change when the real pipeline lands.
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
    const res = await runPipelineAndPersist(supabase, {
      userId: user.id,
      photos: [path],
    });
    itemId = res.itemId;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Processing failed.";
    redirect(`/upload?error=${encodeURIComponent(message)}`);
  }

  redirect(`/review/${itemId}`);
}
