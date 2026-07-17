import { describe, expect, it, vi } from "vitest";
import {
  GuestClaimStorageError,
  claimGuestRecovery,
  type GuestClaimStore,
  type GuestClaimStorage,
} from "./service";

const handoff = {
  recoveryId: "11111111-1111-4111-8111-111111111111",
  guestUserId: "guest_fixture",
  recoveryTokenHash: "a".repeat(64),
};

const terminal = {
  outcome: "claimed" as const,
  itemId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  draftId: "44444444-4444-4444-8444-444444444444",
  purgeLocalRecovery: true as const,
};

const plan = {
  outcome: "copy_required" as const,
  claimLeaseToken: "55555555-5555-4555-8555-555555555555",
  expiresAt: "2026-07-18T12:00:00.000Z",
  itemId: terminal.itemId,
  runId: terminal.runId,
  draftId: terminal.draftId,
  objects: [
    {
      sourcePath: "guest_fixture/items/front.enc",
      destinationPath: "user_account/items/front.enc",
      sha256: "b".repeat(64),
      byteLength: 128,
    },
    {
      sourcePath: "guest_fixture/items/back.enc",
      destinationPath: "user_account/items/back.enc",
      sha256: "c".repeat(64),
      byteLength: 256,
    },
  ],
};

function store(overrides: Partial<GuestClaimStore> = {}): GuestClaimStore {
  return {
    beginClaim: vi.fn().mockResolvedValue(plan),
    completeClaim: vi.fn().mockResolvedValue(terminal),
    releaseClaim: vi.fn().mockResolvedValue({ outcome: "released" }),
    resolveOutcome: vi.fn().mockResolvedValue({ outcome: "claimable" }),
    ...overrides,
  };
}

function storage(overrides: Partial<GuestClaimStorage> = {}): GuestClaimStorage {
  return {
    copyAndVerify: vi.fn(async (object) => ({
      destinationPath: object.destinationPath,
      sha256: object.sha256,
      byteLength: object.byteLength,
    })),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("guest claim-or-expire orchestrator", () => {
  it("copies and verifies every private object before the atomic claim becomes authoritative", async () => {
    const claimStore = store();
    const privateStorage = storage();

    await expect(
      claimGuestRecovery(
        { handoff, targetUserId: "user_account" },
        { store: claimStore, storage: privateStorage },
      ),
    ).resolves.toEqual(terminal);

    expect(privateStorage.copyAndVerify).toHaveBeenCalledTimes(2);
    expect(claimStore.completeClaim).toHaveBeenCalledWith({
      recoveryId: handoff.recoveryId,
      recoveryTokenHash: handoff.recoveryTokenHash,
      targetUserId: "user_account",
      claimLeaseToken: plan.claimLeaseToken,
      verifiedObjects: plan.objects.map(({ destinationPath, sha256, byteLength }) => ({
        destinationPath,
        sha256,
        byteLength,
      })),
    });
  });

  it("returns terminal retries without copying or remapping again", async () => {
    const claimStore = store({ beginClaim: vi.fn().mockResolvedValue(terminal) });
    const privateStorage = storage();

    await expect(
      claimGuestRecovery(
        { handoff, targetUserId: "user_account" },
        { store: claimStore, storage: privateStorage },
      ),
    ).resolves.toEqual(terminal);
    expect(privateStorage.copyAndVerify).not.toHaveBeenCalled();
    expect(claimStore.completeClaim).not.toHaveBeenCalled();
  });

  it("releases a failed copy and removes partial account objects while guest state stays claimable", async () => {
    const claimStore = store();
    const privateStorage = storage({
      copyAndVerify: vi
        .fn()
        .mockResolvedValueOnce({
          destinationPath: plan.objects[0].destinationPath,
          sha256: plan.objects[0].sha256,
          byteLength: plan.objects[0].byteLength,
        })
        .mockRejectedValueOnce(new Error("checksum mismatch: internal detail")),
    });

    await expect(
      claimGuestRecovery(
        { handoff, targetUserId: "user_account" },
        { store: claimStore, storage: privateStorage },
      ),
    ).rejects.toBeInstanceOf(GuestClaimStorageError);

    expect(claimStore.completeClaim).not.toHaveBeenCalled();
    expect(claimStore.releaseClaim).toHaveBeenCalledWith({
      recoveryId: handoff.recoveryId,
      recoveryTokenHash: handoff.recoveryTokenHash,
      targetUserId: "user_account",
      claimLeaseToken: plan.claimLeaseToken,
    });
    expect(privateStorage.remove).toHaveBeenCalledWith(
      plan.objects.map((object) => object.destinationPath),
    );
  });

  it("resolves an interrupted completion before cleanup so a committed claim can never lose its copied photos", async () => {
    const claimStore = store({
      completeClaim: vi.fn().mockRejectedValue(new Error("response lost")),
      resolveOutcome: vi.fn().mockResolvedValue(terminal),
    });
    const privateStorage = storage();

    await expect(
      claimGuestRecovery(
        { handoff, targetUserId: "user_account" },
        { store: claimStore, storage: privateStorage },
      ),
    ).resolves.toEqual(terminal);
    expect(privateStorage.remove).not.toHaveBeenCalled();
    expect(claimStore.releaseClaim).not.toHaveBeenCalled();
  });
});
