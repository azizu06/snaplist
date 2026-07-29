import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createVerifiedGuestCapabilityService } from "./service";

const assertion = {
  appId: "TEAMID1234.dev.snaplist.ios",
  bundleVersion: "42",
  counter: 7,
  environment: "production" as const,
  keyId: "app-attest-key-id",
  kind: "assertion" as const,
  requestHash: "verified-request-hash",
  status: "verified" as const,
  validationCategory: 4,
};

describe("verified guest capability service", () => {
  it("issues an opaque 30-minute bearer from verified App Attest truth and stores only its digest", async () => {
    const issue = vi.fn().mockResolvedValue(true);
    const clock = () => new Date("2026-07-28T15:00:00.000Z");
    const service = createVerifiedGuestCapabilityService({
      clock,
      randomBytes: () => Buffer.alloc(32, 0x33),
      randomUUID: () => "33200000-0000-4000-8000-000000000001",
      store: { issue, resolve: vi.fn() },
    });

    const capability = await service.issue(assertion);

    expect(capability).toEqual({
      bearerToken: `guestcap_${Buffer.alloc(32, 0x33).toString("base64url")}`,
      expiresAt: "2026-07-28T15:30:00.000Z",
      refreshAfter: "2026-07-28T15:25:00.000Z",
    });
    expect(issue).toHaveBeenCalledWith({
      activatedAt: new Date("2026-07-28T15:00:00.000Z"),
      bearerDigest: createHash("sha256")
        .update(capability.bearerToken)
        .digest(),
      capabilityId: "33200000-0000-4000-8000-000000000001",
      expiresAt: new Date("2026-07-28T15:30:00.000Z"),
      userId: expect.stringMatching(/^guest_[0-9a-f]{48}$/),
    });
    expect(JSON.stringify(issue.mock.calls)).not.toContain(capability.bearerToken);
  });

  it("keeps the device subject stable and resolves only canonical opaque bearers", async () => {
    const issue = vi.fn().mockResolvedValue(true);
    const resolve = vi.fn().mockResolvedValue({
      capabilityId: "33200000-0000-4000-8000-000000000002",
      userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    let nextByte = 0x44;
    let now = new Date("2026-07-28T15:00:00.000Z");
    const service = createVerifiedGuestCapabilityService({
      clock: () => now,
      randomBytes: () => Buffer.alloc(32, nextByte++),
      randomUUID: () => "33200000-0000-4000-8000-000000000001",
      store: { issue, resolve },
    });

    const first = await service.issue(assertion);
    now = new Date("2026-07-28T15:25:00.000Z");
    const second = await service.issue({ ...assertion, counter: 8 });
    const resolved = await service.resolve(first.bearerToken);

    expect(resolve).toHaveBeenCalledWith(
      createHash("sha256").update(first.bearerToken).digest(),
    );
    expect(resolved).toEqual({
      capabilityId: "33200000-0000-4000-8000-000000000002",
      userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    expect(first.bearerToken).not.toBe(second.bearerToken);
    expect(issue.mock.calls[0]![0].userId).toBe(issue.mock.calls[1]![0].userId);
    await expect(service.resolve("signed-clerk-jwt")).rejects.toThrow(
      /guest capability/i,
    );
  });

  it("issues a distinct digest-only replacement after an earlier response is lost", async () => {
    const issue = vi.fn().mockResolvedValue(true);
    let nextByte = 0x61;
    let nextId = 1;
    const service = createVerifiedGuestCapabilityService({
      clock: () => new Date("2026-07-28T15:00:00.000Z"),
      randomBytes: () => Buffer.alloc(32, nextByte++),
      randomUUID: () =>
        `33200000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
      store: { issue, resolve: vi.fn() },
    });

    const unreachableResponse = await service.issue(assertion);
    const replacement = await service.issue({ ...assertion, counter: 8 });

    expect(replacement.bearerToken).not.toBe(unreachableResponse.bearerToken);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(issue.mock.calls[0]![0].userId).toBe(issue.mock.calls[1]![0].userId);
    expect(issue.mock.calls[0]![0].bearerDigest).not.toEqual(
      issue.mock.calls[1]![0].bearerDigest,
    );
    expect(JSON.stringify(issue.mock.calls)).not.toContain(
      unreachableResponse.bearerToken,
    );
    expect(JSON.stringify(issue.mock.calls)).not.toContain(
      replacement.bearerToken,
    );
  });
});
