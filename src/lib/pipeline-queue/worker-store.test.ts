import { describe, expect, it, vi } from "vitest";
import {
  createSupabasePipelineWorkerStore,
  type PipelineWorkerRpcClient,
} from "./worker-store";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

function rpcClient(responses: Record<string, unknown>) {
  return {
    rpc: vi.fn(async (name: string) => ({ data: responses[name], error: null })),
  } as unknown as PipelineWorkerRpcClient & { rpc: ReturnType<typeof vi.fn> };
}

describe("run-scoped pipeline worker store", () => {
  it("loads tenant context from run id without accepting user or item identity", async () => {
    const context = {
      run: {
        id: RUN_ID,
        user_id: "user_a",
        item_id: ITEM_ID,
        listing_id: null,
        status: "queued",
        stage: "queued",
        schema_version: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
      item: {
        id: ITEM_ID,
        user_id: "user_a",
        photos: ["user_a/photo.jpg"],
        attributes: {},
        condition: null,
        cost_basis: null,
        review_revision: "44444444-4444-4444-8444-444444444444",
        review_content_revision: "55555555-5555-4555-8555-555555555555",
      },
    };
    const client = rpcClient({ load_pipeline_run_worker_context: context });
    const store = createSupabasePipelineWorkerStore(client);

    await expect(store.loadContext(RUN_ID)).resolves.toEqual(context);
    expect(client.rpc).toHaveBeenCalledWith("load_pipeline_run_worker_context", {
      p_run_id: RUN_ID,
    });
  });

  it("transitions only the claimed run and never accepts tenant-domain payloads", async () => {
    const transitioned = {
      id: RUN_ID,
      user_id: "user_a",
      item_id: ITEM_ID,
      listing_id: null,
      status: "running",
      stage: "identifying",
      schema_version: 1,
      attempt_count: 1,
      max_attempts: 3,
    };
    const client = rpcClient({ transition_pipeline_run: transitioned });
    const store = createSupabasePipelineWorkerStore(client);

    await expect(
      store.transition({
        runId: RUN_ID,
        expectedStatus: "queued",
        nextStatus: "running",
        nextStage: "identifying",
        attemptCount: 1,
      }),
    ).resolves.toMatchObject(transitioned);
    expect(client.rpc).toHaveBeenCalledWith("transition_pipeline_run", {
      p_attempt_count: 1,
      p_expected_status: "queued",
      p_failure_code: null,
      p_failure_message: null,
      p_next_stage: "identifying",
      p_next_status: "running",
      p_run_id: RUN_ID,
    });
  });

  it("links only a relation id and leaves ownership validation to the audited RPC", async () => {
    const linked = {
      id: RUN_ID,
      user_id: "user_a",
      item_id: ITEM_ID,
      listing_id: LISTING_ID,
      status: "running",
      stage: "persisting",
      schema_version: 1,
      attempt_count: 1,
      max_attempts: 3,
    };
    const client = rpcClient({ link_pipeline_run_listing: linked });
    const store = createSupabasePipelineWorkerStore(client);

    await expect(store.linkListing(RUN_ID, LISTING_ID)).resolves.toMatchObject(linked);
    expect(client.rpc).toHaveBeenCalledWith("link_pipeline_run_listing", {
      p_listing_id: LISTING_ID,
      p_run_id: RUN_ID,
    });
  });
});
