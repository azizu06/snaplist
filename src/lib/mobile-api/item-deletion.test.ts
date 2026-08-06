import { describe, expect, it } from "vitest";
import { createMobileApiHandler } from "./app";
import type { ItemDeletionGateway } from "./app";
import { ItemDeletionBlockedError, ItemDeletionNotFoundError } from "@/lib/item-deletion/service";

/**
 * The native transport for the item-deletion executor (issue #181).
 *
 * The route holds no capability. `public.delete_item` decides what may be
 * deleted, what is refused, and which provider-owned records survive; what is
 * tested here is that the transport reports a refusal as a refusal and never
 * reports a deletion SnapList did not perform.
 */

const ITEM_ID = "18100000-0000-4000-8000-000000000001";

function handlerWith(gateway: Partial<ItemDeletionGateway>) {
  return createMobileApiHandler({
    async authenticate() {
      return { kind: "clerk", userId: "user_181" };
    },
    worker: {} as never,
    itemDeletion: {
      async delete() {
        throw new Error("delete was not stubbed for this test");
      },
      ...gateway,
    },
    requestId: () => "req_181",
  });
}

function del(itemId = ITEM_ID, headers: Record<string, string> = {
  authorization: "Bearer token",
}): Request {
  return new Request(`https://api.test/v1/items/${itemId}`, {
    method: "DELETE",
    headers,
  });
}

describe("DELETE /v1/items/{itemId}", () => {
  it("reports the deletion and the provider records it could not delete", async () => {
    const response = await handlerWith({
      async delete() {
        return { status: "deleted", itemId: ITEM_ID, retainedRecords: ["ebay-live-listing"] };
      },
    })(del());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        itemId: ITEM_ID,
        retainedRecords: ["ebay-live-listing"],
      },
      meta: { requestId: "req_181" },
    });
  });

  it("answers a refusal with 409 and the reasons the executor gave", async () => {
    const response = await handlerWith({
      async delete() {
        throw new ItemDeletionBlockedError(["ebay-publish-in-progress"]);
      },
    })(del());

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; details?: { blockedBy?: string[] } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details?.blockedBy).toEqual(["ebay-publish-in-progress"]);
  });

  it("answers 404 for an item the caller does not own", async () => {
    const response = await handlerWith({
      async delete() {
        throw new ItemDeletionNotFoundError();
      },
    })(del());

    expect(response.status).toBe(404);
  });

  it("rejects a malformed item id before reaching the executor", async () => {
    let called = false;
    const response = await handlerWith({
      async delete() {
        called = true;
        return { status: "deleted", itemId: ITEM_ID, retainedRecords: [] };
      },
    })(del("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("requires a bearer token", async () => {
    const response = await handlerWith({})(del(ITEM_ID, {}));
    expect(response.status).toBe(401);
  });

  it("answers 503 when the executor is not configured", async () => {
    const response = await createMobileApiHandler({
      async authenticate() {
        return { kind: "clerk", userId: "user_181" };
      },
      worker: {} as never,
      requestId: () => "req_181",
    })(del());
    expect(response.status).toBe(503);
  });
});
