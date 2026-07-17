import type {
  PipelineReplayBatchInput,
  PipelineStageBatchInput,
  PipelineStageBatchResult,
} from "@/lib/pipeline-staging";

const ACCEPTED_PHOTO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export interface PendingUploadEntry {
  idempotencyKey: string;
  source: "single" | "batch";
  autopilotEnabled: boolean;
  costBasis: number | null;
  photos: File[];
}

export interface StageUploadEntriesInput {
  batchId: string;
  userId: string;
  dailyLimit: number;
  perMinuteLimit: number;
  entries: PendingUploadEntry[];
}

export interface UploadStagingDependencies {
  upload(path: string, photo: File): Promise<void>;
  remove(paths: string[]): Promise<void>;
  findReplay(input: PipelineReplayBatchInput): Promise<PipelineStageBatchResult>;
  stageAndEnqueue(input: PipelineStageBatchInput): Promise<PipelineStageBatchResult>;
}

function extensionFor(photo: File): string {
  switch (photo.type) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

function validateEntry(entry: PendingUploadEntry): void {
  if (entry.photos.length < 1) {
    throw new Error("Choose at least one photo for each item.");
  }
  if (entry.photos.length > 4) {
    throw new Error("Up to 4 photos per item.");
  }
  for (const photo of entry.photos) {
    if (!(photo instanceof File) || !ACCEPTED_PHOTO_TYPES.has(photo.type)) {
      throw new Error("Unsupported file type. Use PNG, JPEG, or WEBP.");
    }
  }
}

/**
 * Upload every private object first, then atomically create all items/runs and
 * enqueue their identifiers-only envelopes. Until the RPC commits, no worker
 * can observe a partial batch. Upload failures are cleaned immediately. If the
 * RPC outcome is ambiguous, replay lookup proves whether this batch committed
 * before this call removes any private objects.
 */
export async function stageUploadEntries(
  input: StageUploadEntriesInput,
  dependencies: UploadStagingDependencies,
): Promise<PipelineStageBatchResult> {
  if (input.entries.length < 1) throw new Error("Add at least one item.");
  input.entries.forEach(validateEntry);

  const uploadedPaths: string[] = [];
  const stagedEntries: PipelineStageBatchInput["entries"] = [];
  let stagingAttempted = false;

  try {
    for (const [entryIndex, entry] of input.entries.entries()) {
      const photoPaths: string[] = [];
      for (const [photoIndex, photo] of entry.photos.entries()) {
        const path = [
          input.userId,
          "pipeline-staging",
          input.batchId,
          String(entryIndex),
          `${photoIndex}-${crypto.randomUUID()}.${extensionFor(photo)}`,
        ].join("/");
        await dependencies.upload(path, photo);
        uploadedPaths.push(path);
        photoPaths.push(path);
      }
      stagedEntries.push({
        idempotencyKey: entry.idempotencyKey,
        source: entry.source,
        autopilotEnabled: entry.autopilotEnabled,
        photoPaths,
        costBasis: entry.costBasis,
      });
    }

    stagingAttempted = true;
    return await dependencies.stageAndEnqueue({
      batchId: input.batchId,
      userId: input.userId,
      dailyLimit: input.dailyLimit,
      perMinuteLimit: input.perMinuteLimit,
      entries: stagedEntries,
    });
  } catch (error) {
    const losingIdempotentRace =
      error instanceof Error &&
      error.message.includes(
        "Pipeline idempotency key conflicts with staged input",
      );
    let cleanupConfirmed = !stagingAttempted;
    if (stagingAttempted) {
      try {
        const replay = await dependencies.findReplay({
          batchId: input.batchId,
          userId: input.userId,
          entries: input.entries.map((entry) => ({
            idempotencyKey: entry.idempotencyKey,
            source: entry.source,
            autopilotEnabled: entry.autopilotEnabled,
            photoCount: entry.photos.length,
            costBasis: entry.costBasis,
          })),
        });
        if (replay.length > 0) {
          if (losingIdempotentRace && uploadedPaths.length > 0) {
            try {
              await dependencies.remove(uploadedPaths);
            } catch {
              // The winner remains authoritative. Retention can retry cleanup
              // of this losing request's unreferenced paths.
            }
          }
          return replay;
        }
        cleanupConfirmed = true;
      } catch {
        // The producer outcome is still ambiguous. Keep the private objects so
        // a committed run cannot lose its photos; retention can clean an
        // unreferenced staging prefix after the ambiguity clears.
      }
    }

    if (cleanupConfirmed && uploadedPaths.length > 0) {
      try {
        await dependencies.remove(uploadedPaths);
      } catch {
        // Preserve the staging error. Storage cleanup is best-effort and owns
        // only this request's new paths; retention can retry leftover objects.
      }
    }
    throw error;
  }
}
