import { describe, expect, it, vi } from "vitest";
import {
  GuestClaimStorageError,
  claimGuestRecovery,
  guestClaimStartSchema,
  guestClaimTerminalOutcomeSchema,
  type GuestClaimStore,
  type GuestClaimStorage,
} from "./service";

const handoff = {
  recoveryId: "11111111-1111-4111-8111-111111111111",
  guestUserId: "guest_fixture",
  recoveryTokenHash: "a".repeat(64),
};

const encryptedArtifact = {
  version: 1 as const,
  algorithm: "aes-256-gcm" as const,
  keyId: "guest-recovery-v1",
  keyEnvelope: Buffer.alloc(32, 1).toString("base64"),
  nonce: Buffer.alloc(12, 2).toString("base64"),
  tag: Buffer.alloc(16, 3).toString("base64"),
  ciphertext: Buffer.from("encrypted-draft").toString("base64"),
};
const objectEncryption = {
  algorithm: "aes-256-gcm" as const,
  keyId: encryptedArtifact.keyId,
  nonce: Buffer.alloc(12, 4).toString("base64"),
  tag: Buffer.alloc(16, 5).toString("base64"),
};
const accountRecovery = {
  encryptedArtifact,
  storageManifest: [{
    destinationPath: "user_account/items/front.enc",
    sha256: "b".repeat(64),
    byteLength: 128,
    encryption: objectEncryption,
  }],
};

const terminal = {
  outcome: "claimed" as const,
  itemId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  draftId: "44444444-4444-4444-8444-444444444444",
  purgeLocalRecovery: true as const,
  accountRecovery,
};

const expired = {
  outcome: "expired" as const,
  itemId: terminal.itemId,
  runId: terminal.runId,
  draftId: terminal.draftId,
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
      encryption: objectEncryption,
    },
    {
      sourcePath: "guest_fixture/items/back.enc",
      destinationPath: "user_account/items/back.enc",
      sha256: "c".repeat(64),
      byteLength: 256,
      encryption: {
        ...objectEncryption,
        nonce: Buffer.alloc(12, 6).toString("base64"),
        tag: Buffer.alloc(16, 7).toString("base64"),
      },
    },
  ],
};

function store(overrides: Partial<GuestClaimStore> = {}): GuestClaimStore {
  return {
    beginClaim: vi.fn().mockResolvedValue(plan),
    completeClaim: vi.fn().mockResolvedValue(terminal),
    releaseClaim: vi.fn().mockResolvedValue({ outcome: "released" }),
    queueCopyCleanup: vi.fn().mockResolvedValue(true),
    resolveOutcome: vi.fn().mockResolvedValue({ outcome: "claimable" }),
    ...overrides,
  };
}

function storage(
  overrides: Partial<GuestClaimStorage> = {},
): GuestClaimStorage & { remove: ReturnType<typeof vi.fn> } {
  return {
    copyAndVerify: vi.fn(async (object) => ({
      destinationPath: object.destinationPath,
      sha256: object.sha256,
      byteLength: object.byteLength,
      encryption: object.encryption,
    })),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("guest claim-or-expire orchestrator", () => {
  it("preserves five ordered objects through guest claim and account recovery contracts", () => {
    const objects = Array.from({ length: 5 }, (_, ordinal) => ({
      sourcePath: `guest_fixture/items/photo-${ordinal}.enc`,
      destinationPath: `user_account/items/photo-${ordinal}.enc`,
      sha256: ordinal.toString(16).repeat(64),
      byteLength: 128 + ordinal,
      encryption: {
        ...objectEncryption,
        nonce: Buffer.alloc(12, ordinal + 10).toString("base64"),
        tag: Buffer.alloc(16, ordinal + 20).toString("base64"),
      },
    }));

    const parsedStart = guestClaimStartSchema.parse({ ...plan, objects });
    expect(parsedStart.outcome).toBe("copy_required");
    if (parsedStart.outcome !== "copy_required") throw new Error("Expected copy plan.");
    expect(parsedStart.objects).toEqual(objects);
    expect(guestClaimTerminalOutcomeSchema.parse({
      ...terminal,
      accountRecovery: {
        encryptedArtifact,
        storageManifest: objects.map(({ sourcePath: _sourcePath, ...object }) => {
          void _sourcePath;
          return object;
        }),
      },
    }).outcome).toBe("claimed");
  });

  it("requires a claimed retry to carry the account-owned recovery contract after local purge", () => {
    const { accountRecovery: _missing, ...withoutRecovery } = terminal;
    void _missing;
    expect(guestClaimTerminalOutcomeSchema.safeParse(withoutRecovery).success).toBe(false);
    expect(guestClaimTerminalOutcomeSchema.safeParse(terminal).success).toBe(true);
  });

  it("copies and verifies every private object before the atomic claim becomes authoritative", async () => {
    const claimStore = store();
    const privateStorage = storage();

    await expect(
      claimGuestRecovery(
        {
          handoff,
          targetUserId: "user_account",
          idempotencyKey: "66666666-6666-4666-8666-666666666666",
        },
        { store: claimStore, storage: privateStorage },
      ),
    ).resolves.toEqual(terminal);

    expect(privateStorage.copyAndVerify).toHaveBeenCalledTimes(2);
    expect(claimStore.completeClaim).toHaveBeenCalledWith({
      recoveryId: handoff.recoveryId,
      recoveryTokenHash: handoff.recoveryTokenHash,
      targetUserId: "user_account",
      claimLeaseToken: plan.claimLeaseToken,
      verifiedObjects: plan.objects.map(
        ({ destinationPath, sha256, byteLength, encryption }) => ({
          destinationPath,
          sha256,
          byteLength,
          encryption,
        }),
      ),
    });
  });

  it("queues the exact expired completion lease before returning the terminal outcome", async () => {
    let finishCleanup: ((queued: boolean) => void) | undefined;
    const cleanupQueued = new Promise<boolean>((resolve) => {
      finishCleanup = resolve;
    });
    const claimStore = store({
      completeClaim: vi.fn().mockResolvedValue(expired),
      queueCopyCleanup: vi.fn().mockReturnValue(cleanupQueued),
    });
    const privateStorage = storage();
    const idempotencyKey = "66666666-6666-4666-8666-666666666666";
    const settled = vi.fn();

    const claim = claimGuestRecovery(
      {
        handoff,
        targetUserId: "user_account",
        idempotencyKey,
      },
      { store: claimStore, storage: privateStorage },
    ).then((outcome) => {
      settled(outcome);
      return outcome;
    });

    await vi.waitFor(() => {
      expect(claimStore.queueCopyCleanup).toHaveBeenCalledWith({
        recoveryId: handoff.recoveryId,
        recoveryTokenHash: handoff.recoveryTokenHash,
        targetUserId: "user_account",
        idempotencyKey,
        claimLeaseToken: plan.claimLeaseToken,
      });
    });
    expect(settled).not.toHaveBeenCalled();

    finishCleanup?.(true);
    await expect(claim).resolves.toEqual(expired);
  });

  it("returns terminal retries without copying or remapping again", async () => {
    const claimStore = store({ beginClaim: vi.fn().mockResolvedValue(terminal) });
    const privateStorage = storage();

    await expect(
      claimGuestRecovery(
        {
          handoff,
          targetUserId: "user_account",
          idempotencyKey: "66666666-6666-4666-8666-666666666666",
        },
        { store: claimStore, storage: privateStorage },
      ),
    ).resolves.toEqual(terminal);
    expect(privateStorage.copyAndVerify).not.toHaveBeenCalled();
    expect(claimStore.completeClaim).not.toHaveBeenCalled();
  });

  it("delegates failed-copy cleanup to the durable release predicate without deleting paths directly", async () => {
    const claimStore = store();
    const privateStorage = storage({
      copyAndVerify: vi
        .fn()
        .mockResolvedValueOnce({
          destinationPath: plan.objects[0].destinationPath,
          sha256: plan.objects[0].sha256,
          byteLength: plan.objects[0].byteLength,
          encryption: plan.objects[0].encryption,
        })
        .mockRejectedValueOnce(new Error("checksum mismatch: internal detail")),
    });

    await expect(
      claimGuestRecovery(
        {
          handoff,
          targetUserId: "user_account",
          idempotencyKey: "66666666-6666-4666-8666-666666666666",
        },
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
    expect(claimStore.queueCopyCleanup).toHaveBeenCalledWith({
      recoveryId: handoff.recoveryId,
      recoveryTokenHash: handoff.recoveryTokenHash,
      targetUserId: "user_account",
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      claimLeaseToken: plan.claimLeaseToken,
    });
    expect(privateStorage.remove).not.toHaveBeenCalled();
  });

  it("fails closed when failed-copy expiry cleanup cannot be confirmed", async () => {
    const claimStore = store({
      queueCopyCleanup: vi.fn().mockRejectedValue(new Error("cleanup unavailable")),
      releaseClaim: vi.fn().mockResolvedValue(expired),
    });
    const privateStorage = storage({
      copyAndVerify: vi.fn().mockRejectedValue(new Error("copy failed")),
    });

    await expect(
      claimGuestRecovery(
        {
          handoff,
          targetUserId: "user_account",
          idempotencyKey: "66666666-6666-4666-8666-666666666666",
        },
        { store: claimStore, storage: privateStorage },
      ),
    ).rejects.toBeInstanceOf(GuestClaimStorageError);
  });

  it("returns a concurrently completed claim instead of letting a stale failed request delete its photos", async () => {
    const claimStore = store({
      releaseClaim: vi.fn().mockResolvedValue(terminal),
    });
    const privateStorage = storage({
      copyAndVerify: vi.fn().mockRejectedValue(new Error("stale copy failed")),
    });

    await expect(
      claimGuestRecovery(
        {
          handoff,
          targetUserId: "user_account",
          idempotencyKey: "66666666-6666-4666-8666-666666666666",
        },
        { store: claimStore, storage: privateStorage },
      ),
    ).resolves.toEqual(terminal);
    expect(privateStorage.remove).not.toHaveBeenCalled();
  });

  it("releases the exact lease before resolving an interrupted completion so late stale writes requeue cleanup", async () => {
    const claimStore = store({
      completeClaim: vi.fn().mockRejectedValue(new Error("response lost")),
      releaseClaim: vi.fn().mockResolvedValue(terminal),
      resolveOutcome: vi.fn().mockRejectedValue(new Error("must not resolve first")),
    });
    const privateStorage = storage();

    await expect(
      claimGuestRecovery(
        {
          handoff,
          targetUserId: "user_account",
          idempotencyKey: "66666666-6666-4666-8666-666666666666",
        },
        { store: claimStore, storage: privateStorage },
      ),
    ).resolves.toEqual(terminal);
    expect(privateStorage.remove).not.toHaveBeenCalled();
    expect(claimStore.releaseClaim).toHaveBeenCalledWith({
      recoveryId: handoff.recoveryId,
      recoveryTokenHash: handoff.recoveryTokenHash,
      targetUserId: "user_account",
      claimLeaseToken: plan.claimLeaseToken,
    });
    expect(claimStore.queueCopyCleanup).toHaveBeenCalledWith({
      recoveryId: handoff.recoveryId,
      recoveryTokenHash: handoff.recoveryTokenHash,
      targetUserId: "user_account",
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      claimLeaseToken: plan.claimLeaseToken,
    });
    expect(claimStore.resolveOutcome).not.toHaveBeenCalled();
  });

  it.each([
    [
      "lease release",
      vi.fn().mockResolvedValue(expired),
      vi.fn().mockRejectedValue(new Error("must not resolve after terminal release")),
    ],
    [
      "outcome resolution",
      vi.fn().mockResolvedValue({ outcome: "released" }),
      vi.fn().mockResolvedValue(expired),
    ],
  ])(
    "fails closed when interrupted completion cleanup cannot be confirmed before %s observes expiry",
    async (_path, releaseClaim, resolveOutcome) => {
      const claimStore = store({
        completeClaim: vi.fn().mockRejectedValue(new Error("response lost")),
        queueCopyCleanup: vi.fn().mockRejectedValue(new Error("cleanup unavailable")),
        releaseClaim,
        resolveOutcome,
      });

      await expect(
        claimGuestRecovery(
          {
            handoff,
            targetUserId: "user_account",
            idempotencyKey: "66666666-6666-4666-8666-666666666666",
          },
          { store: claimStore, storage: storage() },
        ),
      ).rejects.toBeInstanceOf(GuestClaimStorageError);
    },
  );
});
