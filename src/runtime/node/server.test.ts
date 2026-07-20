import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createMobileApiHandler } from "@/lib/mobile-api/app";
import { createSupabaseHomeProjectionReader } from "@/lib/home/projection";
import { startNodeMobileRuntime } from "./server";

const servers: Array<{ close: (callback: (error?: Error) => void) => void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

describe("standalone Node mobile runtime", () => {
  it("serves the Web Request handler outside Next.js", async () => {
    const handler = createMobileApiHandler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_native" }),
      worker: {
        consume: vi.fn().mockResolvedValue({
          claimed: 0,
          succeeded: 0,
          retrying: 0,
          failed: 0,
          skipped: 0,
        }),
      },
      workerSecret: "worker-secret",
      requestId: () => "req_node",
    });
    const server = await startNodeMobileRuntime({ handler, host: "127.0.0.1", port: 0 });
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { apiVersion: "v1", status: "ok" },
    });
  });

  it("serves the authenticated Home projection through the real HTTP adapter", async () => {
    const queriedTables: string[] = [];
    const from = vi.fn((table: string) => {
      queriedTables.push(table);
      let exactCount = false;
      const query = {
        select: vi.fn((_columns?: string, options?: { count?: string; head?: boolean }) => {
          exactCount = options?.count === "exact" && options.head === true;
          return query;
        }),
        eq: vi.fn(() => query),
        in: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(async () =>
          exactCount
            ? { data: null, error: null, count: 0 }
            : { data: [], error: null },
        ),
        range: vi.fn().mockResolvedValue({ data: [], error: null }),
        is: vi.fn().mockResolvedValue({ data: null, error: null, count: 0 }),
      };
      return query;
    });
    const rpc = vi.fn().mockResolvedValue({
      data: {
        history_revision_at: null,
        listings: [],
        items: [],
        predictions: [],
      },
      error: null,
    });
    const clientForBearer = vi.fn().mockReturnValue({ from, rpc });
    const homeProjection = createSupabaseHomeProjectionReader(
      clientForBearer as never,
    );
    const authenticate = vi.fn().mockResolvedValue({ userId: "user_release" });
    const handler = createMobileApiHandler({
      authenticate,
      homeProjection,
      worker: {
        consume: vi.fn().mockResolvedValue({
          claimed: 0,
          succeeded: 0,
          retrying: 0,
          failed: 0,
          skipped: 0,
        }),
      },
      requestId: () => "req_home_release",
    });
    const server = await startNodeMobileRuntime({ handler, host: "127.0.0.1", port: 0 });
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/home`, {
      headers: { authorization: "Bearer release-jwt" },
    });

    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledWith("release-jwt");
    expect(clientForBearer).toHaveBeenCalledWith("release-jwt");
    expect(queriedTables).toEqual([
      "notifications",
      "notifications",
      "pipeline_runs",
      "listings",
      "listings",
    ]);
    expect(rpc).toHaveBeenCalledWith("get_home_current_item_projection");
    await expect(response.json()).resolves.toEqual({
      data: {
        revision: 0,
        sellerState: "newSeller",
        unreadNotificationCount: 0,
        summary: { active: 0, drafts: 0, orders: null },
        attention: [],
        currentRun: null,
        readyToFinish: [],
        listings: [],
        recentSearches: [],
      },
      meta: { requestId: "req_home_release" },
    });
  });
});
