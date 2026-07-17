"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { tierLimits } from "@/lib/abuse";
import { getUserId } from "@/lib/auth";
import { resolveNewAiItemRunPolicy } from "@/lib/billing";
import { createInternalPipelineStagingStore } from "@/lib/pipeline-staging/internal";
import { parseCostBasis } from "@/lib/pipeline/autopilot";
import { reportServerError } from "@/lib/sentry";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { createClient } from "@/lib/supabase/server";
import { stageUploadEntries } from "@/lib/upload-staging";

function redirectUploadError(message: string, batchId?: string): never {
  const params = new URLSearchParams({ error: message });
  if (batchId) params.set("batch", batchId);
  redirect(`/upload?${params.toString()}`);
}

export async function enqueueUpload(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/upload");

  const photos = formData
    .getAll("photo")
    .filter((value): value is File => value instanceof File && value.size > 0);
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();
  const batchId = z.string().uuid().safeParse(formData.get("batchId"));
  if (!batchId.success) redirectUploadError("Please try that upload again.");
  if (!idempotencyKey) {
    redirectUploadError("Please try that upload again.", batchId.data);
  }

  let costBasis: number | null;
  try {
    costBasis = parseCostBasis(formData.get("costBasis"));
  } catch {
    redirectUploadError(
      "What did you pay must be a plain dollar amount or left blank.",
      batchId.data,
    );
  }

  const autopilotEnabled = await getAutopilotEnabled(supabase, userId);
  const store = createInternalPipelineStagingStore();

  try {
    const replay = await store.findReplay({
      batchId: batchId.data,
      userId,
      entries: [{
        idempotencyKey,
        source: "single",
        autopilotEnabled,
        photoCount: photos.length,
        costBasis,
      }],
    });
    if (replay[0]) redirect(`/review/${replay[0].item_id}?new=1`);

    const itemRunPolicy = await resolveNewAiItemRunPolicy(userId, {
      client: supabase,
    });
    if (!itemRunPolicy.allowed) {
      if (itemRunPolicy.reason === "policy-unavailable") {
        redirectUploadError(
          "We couldn't verify whether this item can start. Please try again.",
          batchId.data,
        );
      }
      redirectUploadError(
        "SnapList Pro is required to start another new item.",
        batchId.data,
      );
    }

    // #155 keeps these daily/minute values as operational guardrails rather
    // than subscription allowance. SnapList Pro authorization is the separate
    // server policy above.
    const limits = tierLimits("free");

    const [staged] = await stageUploadEntries(
      {
        batchId: batchId.data,
        userId,
        dailyLimit: limits.itemsPerDay,
        perMinuteLimit: limits.meteredPerMinute,
        entries: [
          {
            idempotencyKey,
            source: "single",
            autopilotEnabled,
            costBasis,
            photos,
          },
        ],
      },
      {
        async upload(path, photo) {
          const { error } = await supabase.storage
            .from("photos")
            .upload(path, photo, { contentType: photo.type, upsert: false });
          if (error) throw error;
        },
        async remove(paths) {
          const { error } = await supabase.storage.from("photos").remove(paths);
          if (error) throw error;
        },
        findReplay: store.findReplay,
        stageAndEnqueue: store.stageAndEnqueue,
        recordCleanupIntent: store.recordCleanupIntent,
        resolveCleanupIntent: store.resolveCleanupIntent,
      },
    );

    if (!staged) throw new Error("Pipeline staging returned no run");
    redirect(`/review/${staged.item_id}?new=1`);
  } catch (error) {
    // Next redirects are represented as thrown control-flow errors. Let them
    // leave unchanged instead of turning a successful enqueue into an error.
    if (error instanceof Error && error.message.startsWith("NEXT_REDIRECT")) throw error;
    if (error instanceof Error && error.message.startsWith("REDIRECT:")) throw error;
    reportServerError("upload.enqueue", error);
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("daily capacity")) {
      redirectUploadError("Capacity limit reached. Try again tomorrow.", batchId.data);
    }
    if (message.includes("per-minute") || message.includes("minute capacity")) {
      redirectUploadError(
        "You are starting listings too quickly. Wait a minute and try again.",
        batchId.data,
      );
    }
    redirectUploadError(
      "We couldn't save this listing for processing. Please try again.",
      batchId.data,
    );
  }
}
