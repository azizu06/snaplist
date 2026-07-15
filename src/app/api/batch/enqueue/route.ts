import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserId } from "@/lib/auth";
import { resolveSellerPolicy } from "@/lib/billing";
import { createInternalPipelineStagingStore } from "@/lib/pipeline-staging/internal";
import { parseCostBasis } from "@/lib/pipeline/autopilot";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { createClient } from "@/lib/supabase/server";
import { stageUploadEntries } from "@/lib/upload-staging";
import { logServerError } from "@/lib/api/errors";

const manifestSchema = z.object({
  batchId: z.string().uuid(),
  entries: z
    .array(
      z.object({
        idempotencyKey: z.string().min(1).max(128),
        costBasis: z.union([z.string(), z.number(), z.null()]),
        photoCount: z.number().int().min(1).max(4),
      }).strict(),
    )
    .min(1)
    .max(200),
}).strict();

export async function POST(request: Request) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  let manifest: z.infer<typeof manifestSchema>;
  try {
    form = await request.formData();
    manifest = manifestSchema.parse(JSON.parse(String(form.get("manifest") ?? "")));
  } catch {
    return NextResponse.json({ error: "This batch could not be read. Try again." }, { status: 400 });
  }

  try {
    const policy = await resolveSellerPolicy(userId, { client: supabase });
    const autopilotEnabled = await getAutopilotEnabled(supabase, userId);
    const entries = manifest.entries.map((entry, index) => {
      const photos = form
        .getAll(`photo:${index}`)
        .filter((value): value is File => value instanceof File && value.size > 0);
      if (photos.length !== entry.photoCount) {
        throw new Error("The batch photo manifest did not match the uploaded files.");
      }
      return {
        idempotencyKey: entry.idempotencyKey,
        source: "batch" as const,
        autopilotEnabled,
        costBasis: parseCostBasis(entry.costBasis),
        photos,
      };
    });
    const store = createInternalPipelineStagingStore();
    const replay = await store.findReplay({
      batchId: manifest.batchId,
      userId,
      entries: entries.map((entry) => ({
        idempotencyKey: entry.idempotencyKey,
        source: entry.source,
        autopilotEnabled: entry.autopilotEnabled,
        photoCount: entry.photos.length,
        costBasis: entry.costBasis,
      })),
    });
    if (replay.length > 0) {
      return NextResponse.json({
        batchId: manifest.batchId,
        runs: replay.map((run) => ({
          id: run.run_id,
          itemId: run.item_id,
          listingId: run.listing_id,
          status: run.status,
          stage: run.stage,
          attemptCount: run.attempt_count,
          maxAttempts: run.max_attempts,
          safeFailureMessage: run.safe_failure_message,
          updatedAt: run.updated_at,
        })),
      }, { status: 200 });
    }

    const runs = await stageUploadEntries(
      {
        batchId: manifest.batchId,
        userId,
        dailyLimit: policy.limits.itemsPerDay,
        perMinuteLimit: policy.limits.meteredPerMinute,
        entries,
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

    return NextResponse.json({
      batchId: manifest.batchId,
      runs: runs.map((run) => ({
        id: run.run_id,
        itemId: run.item_id,
        listingId: run.listing_id,
        status: run.status,
        stage: run.stage,
        attemptCount: run.attempt_count,
        maxAttempts: run.max_attempts,
        safeFailureMessage: run.safe_failure_message,
        updatedAt: run.updated_at,
      })),
    }, { status: 202 });
  } catch (error) {
    logServerError("batch.enqueue", error);
    const detail = error instanceof Error ? error.message.toLowerCase() : "";
    if (detail.includes("daily capacity")) {
      return NextResponse.json(
        { error: "This batch is over your remaining daily item limit.", kind: "quota" },
        { status: 429 },
      );
    }
    if (detail.includes("minute capacity") || detail.includes("per-minute")) {
      return NextResponse.json(
        { error: "You are starting listings too quickly. Wait a minute and try again.", kind: "rate-limit" },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: "We couldn't save this batch for processing. Please try again." },
      { status: 500 },
    );
  }
}
