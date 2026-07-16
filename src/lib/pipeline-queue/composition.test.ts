import { describe, expect, it, vi } from "vitest";
import type { VisionPipelineStages } from "@/lib/vision";
import type { PipelineWorkerStore } from "./worker-store";
import {
  createPipelinePhotoCapability,
  createPipelineWorker,
} from "./composition";

function unusedStages(): VisionPipelineStages {
  const unused = async () => {
    throw new Error("stage should not run when the queue is empty");
  };
  return {
    identify: unused,
    price: unused,
    generate: unused,
    assemble: () => {
      throw new Error("assemble should not run when the queue is empty");
    },
  } as unknown as VisionPipelineStages;
}

describe("provider-neutral pipeline worker composition", () => {
  it("runs the existing bounded consumer through injected capabilities", async () => {
    const claim = vi.fn().mockResolvedValue([]);
    const worker = createPipelineWorker({
      capabilities: {
        queue: {
          enqueue: vi.fn(),
          claim,
          ack: vi.fn(),
          defer: vi.fn(),
        },
        runs: {} as PipelineWorkerStore,
        photos: {} as never,
      },
      createStages: () => unusedStages(),
      consumerOptions: { batchSize: 2, visibilityTimeoutSeconds: 120 },
    });

    await expect(worker.consume()).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      retrying: 0,
      failed: 0,
      skipped: 0,
    });
    expect(claim).toHaveBeenCalledWith({
      limit: 2,
      visibilityTimeoutSeconds: 120,
    });
  });

  it("keeps runtime storage authority restricted to the private photos bucket", async () => {
    const download = vi.fn().mockResolvedValue({ data: new Blob(), error: null });
    const from = vi.fn(() => ({ download }));
    const photos = createPipelinePhotoCapability({ from });

    expect(() => photos.storage.from("message-photos")).toThrow(
      /private photos bucket/,
    );
    await expect(photos.storage.from("photos").download("user/item.jpg")).resolves.toEqual({
      data: expect.any(Blob),
      error: null,
    });
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("photos");
  });
});
