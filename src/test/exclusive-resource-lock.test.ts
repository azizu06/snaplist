import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
});
