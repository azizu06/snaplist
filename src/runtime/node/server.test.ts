import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createMobileApiHandler } from "@/lib/mobile-api/app";
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
});
