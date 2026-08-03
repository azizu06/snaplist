import { describe, expect, it } from "vitest";
import { createMobileApiHandler } from "./app";
import type { AssistedExportHandoffGateway } from "./app";
import type { ExportHandoffsView } from "@/lib/export/handoff";

/**
 * The native transport for the assisted-export seam that shipped in #580
 * (issue #581).
 *
 * This route holds no capability of its own. It authenticates the bearer and
 * hands the seller's two revisions straight to `record_export_handoff`,
 * `mark_export_shared`, and `undo_export_shared`, which are the only writers
 * and the only authority on whether a write is allowed. What is tested here is
 * that the transport neither invents a `shared` claim the database refused nor
 * flattens a refusal into something the client cannot act on.
 *
 * Every mutation answers with re-read state rather than with a view composed
 * from its own return value. The mutation RPCs each report one timestamp, so
 * composing from them would describe a destination by the last thing that
 * happened to it instead of by what is true of it now.
 */

const ITEM_ID = "58100000-0000-4000-8000-000000000001";
const CONTENT_REVISION = "58100000-0000-4000-8000-0000000000c0";
const REVIEW_REVISION = "58100000-0000-4000-8000-0000000000a0";
const EFFECTIVE_PRICE = 177.77;
const HANDED_OFF_AT = "2026-07-25T15:00:00.000Z";
const SHARED_AT = "2026-07-25T16:00:00.000Z";

function allPrepared(): ExportHandoffsView {
  return {
    facebook: { platform: "facebook", state: "prepared", handedOffAt: null, sharedAt: null },
    mercari: { platform: "mercari", state: "prepared", handedOffAt: null, sharedAt: null },
    depop: { platform: "depop", state: "prepared", handedOffAt: null, sharedAt: null },
  };
}

function currentPack() {
  return {
    effectivePrice: EFFECTIVE_PRICE,
    reviewRevision: REVIEW_REVISION,
  };
}

function handlerWith(gateway: Partial<AssistedExportHandoffGateway>) {
  return createMobileApiHandler({
    async authenticate() {
      return { kind: "clerk", userId: "user_581" };
    },
    worker: {} as never,
    assistedExport: {
      async load() {
        return { handoffs: allPrepared(), ...currentPack() };
      },
      async recordHandoff() {
        throw new Error("recordHandoff was not stubbed for this test");
      },
      async markShared() {
        throw new Error("markShared was not stubbed for this test");
      },
      async undoShared() {
        throw new Error("undoShared was not stubbed for this test");
      },
      ...gateway,
    },
    requestId: () => "req_581",
  });
}

function get(itemId = ITEM_ID): Request {
  return new Request(
    `https://api.test/v1/items/${itemId}/export-handoffs?reviewContentRevision=${CONTENT_REVISION}`,
    { headers: { authorization: "Bearer token" } },
  );
}

function post(body: unknown): Request {
  return new Request(`https://api.test/v1/items/${ITEM_ID}/export-handoffs`, {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function sharedBody(platform = "mercari") {
  return {
    platform,
    action: "shared",
    reviewContentRevision: CONTENT_REVISION,
    reviewRevision: REVIEW_REVISION,
  };
}

describe("assisted export handoffs over the mobile API", () => {
  it("serves the server-resolved effective price with the guarded pack", async () => {
    const response = await handlerWith({})(get());

    expect(response.status).toBe(200);
    expect((await response.json()).data.pack).toEqual(currentPack());
  });

  it("names all three assisted destinations even when nothing has happened yet", async () => {
    const handler = handlerWith({});

    const response = await handler(get());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.handoffs).toEqual([
      { platform: "facebook", state: "prepared", handedOffAt: null, sharedAt: null },
      { platform: "mercari", state: "prepared", handedOffAt: null, sharedAt: null },
      { platform: "depop", state: "prepared", handedOffAt: null, sharedAt: null },
    ]);
  });

  it("reads the destinations the seller's own pack revision belongs to", async () => {
    const seen: unknown[] = [];
    const handler = handlerWith({
      async load(input) {
        seen.push(input);
        return { handoffs: allPrepared(), ...currentPack() };
      },
    });

    await handler(get());

    expect(seen).toEqual([
      {
        userId: "user_581",
        bearerToken: "token",
        itemId: ITEM_ID,
        reviewContentRevision: CONTENT_REVISION,
      },
    ]);
  });

  it("hands the database both revisions so the guard stays where it can be enforced", async () => {
    const seen: unknown[] = [];
    const handler = handlerWith({
      async markShared(input) {
        seen.push(input);
        return SHARED_AT;
      },
    });

    const response = await handler(post(sharedBody()));

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        userId: "user_581",
        bearerToken: "token",
        itemId: ITEM_ID,
        platform: "mercari",
        reviewContentRevision: CONTENT_REVISION,
        reviewRevision: REVIEW_REVISION,
      },
    ]);
  });

  it("answers a confirmation with re-read state rather than with its own optimism", async () => {
    let confirmed = false;
    const handler = handlerWith({
      async markShared() {
        confirmed = true;
        return SHARED_AT;
      },
      async load() {
        const view = allPrepared();
        if (confirmed) {
          view.mercari = {
            platform: "mercari",
            state: "shared",
            handedOffAt: HANDED_OFF_AT,
            sharedAt: SHARED_AT,
          };
        }
        return { handoffs: view, ...currentPack() };
      },
    });

    const body = await (await handler(post(sharedBody()))).json();

    expect(body.data.handoffs[1]).toEqual({
      platform: "mercari",
      state: "shared",
      handedOffAt: HANDED_OFF_AT,
      sharedAt: SHARED_AT,
    });
  });

  it("keeps a stale-pack refusal distinguishable so the seller's sheet can reopen", async () => {
    const handler = handlerWith({
      async markShared() {
        throw Object.assign(new Error("the pack went stale"), {
          name: "ExportHandoffError",
          code: "P0002",
        });
      },
    });

    const response = await handler(post(sharedBody()));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
  });

  it("never says shared when the write was refused", async () => {
    const handler = handlerWith({
      async markShared() {
        throw Object.assign(new Error("this destination is not assisted"), {
          name: "ExportHandoffError",
          code: "22023",
        });
      },
      async load() {
        throw new Error("a refused mutation must not be followed by a re-read");
      },
    });

    const response = await handler(post(sharedBody("depop")));

    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("shared");
  });

  it("records a handoff without letting it become a claim", async () => {
    let recorded = false;
    const handler = handlerWith({
      async recordHandoff() {
        recorded = true;
        return HANDED_OFF_AT;
      },
      async load() {
        const view = allPrepared();
        if (recorded) {
          view.facebook = {
            platform: "facebook",
            state: "prepared",
            handedOffAt: HANDED_OFF_AT,
            sharedAt: null,
          };
        }
        return { handoffs: view, ...currentPack() };
      },
    });

    const body = await (
      await handler(
        post({
          platform: "facebook",
          action: "handoff",
          reviewContentRevision: CONTENT_REVISION,
          reviewRevision: REVIEW_REVISION,
        }),
      )
    ).json();

    expect(body.data.handoffs[0]).toEqual({
      platform: "facebook",
      state: "prepared",
      handedOffAt: HANDED_OFF_AT,
      sharedAt: null,
    });
  });

  it("returns a destination to prepared on undo and leaves the handoff standing", async () => {
    let undone = false;
    const handler = handlerWith({
      async undoShared() {
        undone = true;
      },
      async load() {
        const view = allPrepared();
        view.mercari = {
          platform: "mercari",
          state: undone ? "prepared" : "shared",
          handedOffAt: HANDED_OFF_AT,
          sharedAt: undone ? null : SHARED_AT,
        };
        return { handoffs: view, ...currentPack() };
      },
    });

    const body = await (
      await handler(
        post({
          platform: "mercari",
          action: "undo",
          reviewContentRevision: CONTENT_REVISION,
          reviewRevision: REVIEW_REVISION,
        }),
      )
    ).json();

    expect(undone).toBe(true);
    expect(body.data.handoffs[1]).toEqual({
      platform: "mercari",
      state: "prepared",
      handedOffAt: HANDED_OFF_AT,
      sharedAt: null,
    });
  });

  it("refuses eBay, which is a transactional adapter and never an assisted handoff", async () => {
    const handler = handlerWith({
      async recordHandoff() {
        throw new Error("ebay must be rejected before any capability is reached");
      },
    });

    const response = await handler(
      post({
        platform: "ebay",
        action: "handoff",
        reviewContentRevision: CONTENT_REVISION,
        reviewRevision: REVIEW_REVISION,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("refuses a confirmation that names no revision at all", async () => {
    const handler = handlerWith({
      async markShared() {
        throw new Error("an unrevisioned confirmation must never reach the capability");
      },
    });

    const response = await handler(
      post({ platform: "mercari", action: "shared" }),
    );

    expect(response.status).toBe(400);
  });

  it("requires a bearer", async () => {
    const handler = handlerWith({
      async load() {
        throw new Error("an unauthenticated read must never reach the capability");
      },
    });

    const response = await handler(
      new Request(
        `https://api.test/v1/items/${ITEM_ID}/export-handoffs?reviewContentRevision=${CONTENT_REVISION}`,
      ),
    );

    expect(response.status).toBe(401);
  });

  it("rejects an item id that is not one", async () => {
    const handler = handlerWith({
      async load() {
        throw new Error("an unparseable item id must never reach the capability");
      },
    });

    const response = await handler(get("not-a-uuid"));

    expect(response.status).toBe(400);
  });
});
