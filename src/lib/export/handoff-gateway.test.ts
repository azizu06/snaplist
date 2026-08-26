import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createConfiguredAssistedExportGateway,
  createSupabaseAssistedExportGateway,
} from "./handoff-gateway";

/**
 * `handoff-gateway.ts` is the wiring the live
 * `/v1/items/[itemId]/export-handoffs` route actually calls — no test
 * exercised it before this. The pure `handoff.ts` functions and the RPC
 * shaping they do are covered by `handoff.test.ts`, but nothing proved the
 * gateway (a) builds one client per call from the caller's own bearer token
 * rather than a shared/service-role client, and (b) forwards each method's
 * arguments to the right underlying function. Either could silently break in
 * a refactor with every other suite still green, because every other test
 * injects a fake gateway that never touches this file.
 */

const loadExportHandoffPack = vi.hoisted(() => vi.fn());
const recordExportHandoff = vi.hoisted(() => vi.fn());
const markExportShared = vi.hoisted(() => vi.fn());
const undoExportShared = vi.hoisted(() => vi.fn());

vi.mock("./handoff", () => ({
  loadExportHandoffPack,
  recordExportHandoff,
  markExportShared,
  undoExportShared,
}));

const createClient = vi.hoisted(() => vi.fn());

vi.mock("@supabase/supabase-js", () => ({ createClient }));

afterEach(() => {
  vi.clearAllMocks();
});

const ITEM_ID = "6ac6d4a1-63b1-4a3e-9d5a-7b2e2d0f1c11";
const CONTENT_REVISION = "1f0d5f6f-2b6c-4a1d-8a54-2f3f1c1c9a01";
const REVIEW_REVISION = "8b3a6d2e-9c1a-4b77-9a02-0c5b7a4e6d02";
const BEARER = "user-bearer-token";

describe("createSupabaseAssistedExportGateway", () => {
  it("builds one client from the call's own bearer token and forwards it to load()", async () => {
    const client = { marker: "scoped-client" } as unknown as SupabaseClient;
    const clientFor = vi.fn(() => client);
    loadExportHandoffPack.mockResolvedValue({ handoffs: {}, effectivePrice: 12, reviewRevision: REVIEW_REVISION });
    const gateway = createSupabaseAssistedExportGateway(clientFor);

    await gateway.load({
      userId: "user_1",
      bearerToken: BEARER,
      itemId: ITEM_ID,
      reviewContentRevision: CONTENT_REVISION,
    });

    expect(clientFor).toHaveBeenCalledWith(BEARER);
    expect(loadExportHandoffPack).toHaveBeenCalledWith(client, {
      itemId: ITEM_ID,
      reviewContentRevision: CONTENT_REVISION,
    });
  });

  it("routes recordHandoff, markShared, and undoShared to their own handoff functions with the scoped client", async () => {
    const client = { marker: "scoped-client" } as unknown as SupabaseClient;
    const clientFor = vi.fn(() => client);
    recordExportHandoff.mockResolvedValue("2026-01-01T00:00:00.000Z");
    markExportShared.mockResolvedValue("2026-01-01T00:01:00.000Z");
    undoExportShared.mockResolvedValue(undefined);
    const gateway = createSupabaseAssistedExportGateway(clientFor);

    const mutation = {
      userId: "user_1",
      bearerToken: BEARER,
      itemId: ITEM_ID,
      platform: "facebook" as const,
      reviewContentRevision: CONTENT_REVISION,
      reviewRevision: REVIEW_REVISION,
    };

    await gateway.recordHandoff(mutation);
    await gateway.markShared(mutation);
    await gateway.undoShared(mutation);

    expect(recordExportHandoff).toHaveBeenCalledWith(client, mutation);
    expect(markExportShared).toHaveBeenCalledWith(client, mutation);
    expect(undoExportShared).toHaveBeenCalledWith(client, mutation);
    expect(clientFor).toHaveBeenCalledTimes(3);
    expect(clientFor).toHaveBeenCalledWith(BEARER);
  });
});

describe("createConfiguredAssistedExportGateway", () => {
  it("scopes every client to the caller's own bearer token instead of a shared session", async () => {
    const scopedClient = { marker: "per-call-client" };
    createClient.mockReturnValue(scopedClient);
    loadExportHandoffPack.mockResolvedValue({ handoffs: {}, effectivePrice: 12, reviewRevision: REVIEW_REVISION });
    const gateway = createConfiguredAssistedExportGateway({
      supabaseURL: "https://example.supabase.co",
      anonKey: "anon-key",
    });

    await gateway.load({
      userId: "user_1",
      bearerToken: BEARER,
      itemId: ITEM_ID,
      reviewContentRevision: CONTENT_REVISION,
    });

    expect(createClient).toHaveBeenCalledTimes(1);
    const [url, anonKey, options] = createClient.mock.calls[0];
    expect(url).toBe("https://example.supabase.co");
    expect(anonKey).toBe("anon-key");
    expect(options.auth).toEqual({ persistSession: false, autoRefreshToken: false });
    await expect(options.accessToken()).resolves.toBe(BEARER);
    expect(loadExportHandoffPack).toHaveBeenCalledWith(scopedClient, {
      itemId: ITEM_ID,
      reviewContentRevision: CONTENT_REVISION,
    });
  });
});
