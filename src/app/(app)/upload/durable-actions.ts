"use server";

import { redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
import { resolveSellerPolicy } from "@/lib/billing";
import { createInternalPipelineStagingStore } from "@/lib/pipeline-staging/internal";
import { parseCostBasis } from "@/lib/pipeline/autopilot";
import { reportServerError } from "@/lib/sentry";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { createClient } from "@/lib/supabase/server";
import { stageUploadEntries } from "@/lib/upload-staging";

function redirectUploadError(message: string): never {
  redirect(`/upload?error=${encodeURIComponent(message)}`);
}

export async function enqueueUpload(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/upload");

  const photos = formData
    .getAll("photo")
    .filter((value): value is File => value instanceof File && value.size > 0);
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();
  if (!idempotencyKey) redirectUploadError("Please try that upload again.");

  let costBasis: number | null;
  try {
    costBasis = parseCostBasis(formData.get("costBasis"));
  } catch {
    redirectUploadError("What did you pay must be a plain dollar amount or left blank.");
  }

  const policy = await resolveSellerPolicy(userId, { client: supabase });
  const autopilotEnabled = await getAutopilotEnabled(supabase, userId);
  const store = createInternalPipelineStagingStore();

  try {
    const [staged] = await stageUploadEntries(
      {
        batchId: crypto.randomUUID(),
        userId,
        dailyLimit: policy.limits.itemsPerDay,
        perMinuteLimit: policy.limits.meteredPerMinute,
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
        stageAndEnqueue: store.stageAndEnqueue,
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
      const plan = policy.tier === "paid" ? "Pro" : "free";
      redirectUploadError(
        `Daily limit reached at ${policy.limits.itemsPerDay} items on the ${plan} plan. Try again tomorrow.`,
      );
    }
    if (message.includes("per-minute") || message.includes("minute capacity")) {
      redirectUploadError("You are starting listings too quickly. Wait a minute and try again.");
    }
    redirectUploadError("We couldn't save this listing for processing. Please try again.");
  }
}
