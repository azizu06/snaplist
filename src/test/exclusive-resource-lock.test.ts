import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { acquireExclusiveTestResource } from "./exclusive-resource-lock";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("exclusive test resource lock", () => {
  it("waits until the current owner releases the same resource", async () => {
    const resource = `same-resource-${randomUUID()}`;
    const first = await acquireExclusiveTestResource(resource);
    let secondAcquired = false;
    const secondPromise = acquireExclusiveTestResource(resource).then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await sleep(50);
    expect(secondAcquired).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
  });

  it("does not serialize independent resources", async () => {
    const suffix = randomUUID();
    const [first, second] = await Promise.all([
      acquireExclusiveTestResource(`resource-a-${suffix}`),
      acquireExclusiveTestResource(`resource-b-${suffix}`),
    ]);

    await Promise.all([first.release(), second.release()]);
  });

  it("does not let a delayed contender delete a successor lease", async () => {
    const resource = `delayed-publish-${randomUUID()}`;
    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow);
    let signalFirstPublish!: () => void;
    const firstMayPublish = new Promise<void>((resolve) => {
      signalFirstPublish = resolve;
    });
    let firstReachedPublish!: () => void;
    const firstAtPublish = new Promise<void>((resolve) => {
      firstReachedPublish = resolve;
    });

    const firstPromise = acquireExclusiveTestResource(resource, {
      beforePublish: async () => {
        firstReachedPublish();
        await firstMayPublish;
      },
      retryDelayMs: 5,
    });

    try {
      await firstAtPublish;
      now.mockReturnValue(realNow + 3_000);
      const successor = await acquireExclusiveTestResource(resource, {
        retryDelayMs: 5,
      });
      signalFirstPublish();

      const earlyFirstOutcome = await Promise.race([
        firstPromise.then(
          () => "acquired" as const,
          () => "rejected" as const,
        ),
        sleep(50).then(() => "waiting" as const),
      ]);

      await successor.release();
      const first = await firstPromise;
      await first.release();
      expect(earlyFirstOutcome).toBe("waiting");
    } finally {
      signalFirstPublish();
      now.mockRestore();
    }
  });
});
