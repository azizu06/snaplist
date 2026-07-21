import type { PipelineResult } from "@/lib/pipeline";
import type { VisionPipelineStages } from "@/lib/vision";
import {
  pipelineWorkerCheckpointSchema,
  pipelineWorkerCheckpointWriteSchema,
  type PipelineWorkerCheckpoint,
} from "./checkpoint";
import type { PipelineWorkerContext } from "./worker-store";
import { PipelineWorkerFailure, type DurablePipelineProcessor } from "./worker";

export type { PipelineWorkerCheckpoint } from "./checkpoint";

function assertRunDerivedPhotos(context: PipelineWorkerContext): void {
  const ownedPath = (path: string): boolean => {
    const segments = path.split("/");
    return (
      segments.length > 1 &&
      segments[0] === context.run.user_id &&
      segments.every(
        (segment) => segment.length > 0 && segment !== "." && segment !== "..",
      )
    );
  };
  if (
    context.item.user_id !== context.run.user_id ||
    context.item.id !== context.run.item_id ||
    context.item.photos.length === 0 ||
    context.item.photos.length > 5 ||
    context.item.photos.some((path) => !ownedPath(path))
  ) {
    throw new PipelineWorkerFailure({
      code: "invalid_run_photos",
      safeMessage: "The saved photos for this listing could not be verified.",
      retryable: false,
    });
  }
}

export function createDurableVisionPipelineProcessor(
  stages: VisionPipelineStages,
): DurablePipelineProcessor {
  return {
    async process({ context, onCheckpoint }): Promise<PipelineResult> {
      assertRunDerivedPhotos(context);
      let checkpoint: PipelineWorkerCheckpoint =
        pipelineWorkerCheckpointSchema.parse(context.run.checkpoint);

      if (!checkpoint.identified) {
        const identified = await stages.identify({ photos: context.item.photos });
        const candidate = pipelineWorkerCheckpointWriteSchema.parse({
          ...checkpoint,
          identified,
        });
        checkpoint = pipelineWorkerCheckpointSchema.parse(
          await onCheckpoint("identifying", candidate),
        );
      }
      const identified = checkpoint.identified;
      if (!identified) {
        throw new PipelineWorkerFailure({
          code: "invalid_checkpoint",
          safeMessage: "The saved identification checkpoint is incomplete.",
          retryable: false,
        });
      }

      if (!checkpoint.priced) {
        const priced = await stages.price({
          attributes: identified.attributes,
        });
        const candidate = pipelineWorkerCheckpointWriteSchema.parse({
          ...checkpoint,
          priced: {
            result: priced,
          },
        });
        checkpoint = pipelineWorkerCheckpointSchema.parse(
          await onCheckpoint("pricing", candidate),
        );
      }
      const priced = checkpoint.priced;

      if (!checkpoint.generated) {
        const generated = await stages.generate({
          attributes: identified.attributes,
        });
        const candidate = pipelineWorkerCheckpointWriteSchema.parse({
          ...checkpoint,
          generated,
        });
        checkpoint = pipelineWorkerCheckpointSchema.parse(
          await onCheckpoint("generating", candidate),
        );
      }
      const generated = checkpoint.generated;

      if (!priced || !generated) {
        throw new PipelineWorkerFailure({
          code: "invalid_checkpoint",
          safeMessage: "The saved processing checkpoint is incomplete.",
          retryable: false,
        });
      }

      return stages.assemble({
        identified,
        price: priced.result,
        generated,
        autopilotEnabled: context.run.autopilot_enabled,
      });
    },
  };
}
