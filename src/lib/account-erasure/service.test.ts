import { describe, expect, it, vi } from "vitest";
import { eraseAccount } from "./service";

const generationId = "38400000-0000-4000-8000-000000000001";
const idempotencyKey = "38400000-0000-4000-8000-000000000002";

const storageObject = {
  bucketId: "photos" as const,
  objectName: "user_384/items/item-1/photo.jpg",
};

function state(overrides: Record<string, unknown> = {}) {
  return {
    generationId,
    status: "deletion_in_progress" as const,
    retainedRecords: [],
    deferrals: [],
    attentionReasons: [],
    identity: { clerkUserId: "user_384", revenueCatAppUserIds: [] },
    storageObjects: [],
    ...overrides,
  };
}

function identityStub() {
  return {
    deleteClerkUser: vi.fn().mockResolvedValue({ absent: true }),
    deleteRevenueCatCustomer: vi.fn().mockResolvedValue({ absent: true }),
  };
}

describe("durable account erasure service", () => {
  it("removes Storage, proves absence, deletes both identities, and completes", async () => {
    const store = {
      begin: vi.fn().mockResolvedValue(
        state({ status: "deletion_requested", storageObjects: [storageObject], identity: null }),
      ),
      confirmStorageAbsence: vi.fn().mockResolvedValue(true),
      advance: vi.fn().mockResolvedValue(state({
        identity: { clerkUserId: "user_384", revenueCatAppUserIds: ["rc_384"] },
      })),
      finalize: vi.fn().mockResolvedValue(state({ status: "deletion_completed", identity: null })),
    };
    const storage = { remove: vi.fn().mockResolvedValue(undefined) };
    const identity = identityStub();

    const result = await eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage, identity },
    );

    expect(storage.remove).toHaveBeenCalledWith(storageObject);
    expect(store.confirmStorageAbsence).toHaveBeenCalledWith({
      generationId,
      ...storageObject,
    });
    expect(identity.deleteClerkUser).toHaveBeenCalledWith({ clerkUserId: "user_384" });
    expect(identity.deleteRevenueCatCustomer).toHaveBeenCalledWith({ appUserId: "rc_384" });
    expect(store.finalize).toHaveBeenCalledWith({
      generationId,
      clerkIdentityAbsent: true,
      revenueCatCustomerAbsent: true,
      attentionReasons: [],
    });
    expect(result.status).toBe("deletion_completed");
  });

  it("reports retained provider records as their own success status", async () => {
    const retained = ["hosted-transcription-provider-copy", "ebay-live-listing"];
    const store = {
      begin: vi.fn().mockResolvedValue(state({ status: "deletion_requested", identity: null })),
      confirmStorageAbsence: vi.fn(),
      advance: vi.fn().mockResolvedValue(state({ retainedRecords: retained })),
      finalize: vi.fn().mockResolvedValue(state({
        status: "deletion_completed_with_retained_records",
        retainedRecords: retained,
        identity: null,
      })),
    };

    const result = await eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage: { remove: vi.fn() }, identity: identityStub() },
    );

    expect(result.status).toBe("deletion_completed_with_retained_records");
    expect(result.retainedRecords).toEqual(retained);
  });

  it("never claims completion when a provider will not confirm absence", async () => {
    const store = {
      begin: vi.fn().mockResolvedValue(state({ status: "deletion_requested", identity: null })),
      confirmStorageAbsence: vi.fn(),
      advance: vi.fn().mockResolvedValue(state({
        identity: { clerkUserId: "user_384", revenueCatAppUserIds: ["rc_384"] },
      })),
      finalize: vi.fn().mockResolvedValue(state({
        status: "deletion_needs_attention",
        attentionReasons: ["revenuecat-customer-deletion-unverified"],
      })),
    };
    const identity = {
      deleteClerkUser: vi.fn().mockResolvedValue({ absent: true }),
      deleteRevenueCatCustomer: vi.fn().mockResolvedValue({ absent: false }),
    };

    const result = await eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage: { remove: vi.fn() }, identity },
    );

    expect(store.finalize).toHaveBeenCalledWith({
      generationId,
      clerkIdentityAbsent: true,
      revenueCatCustomerAbsent: false,
      attentionReasons: ["revenuecat-customer-deletion-unverified"],
    });
    expect(result.status).toBe("deletion_needs_attention");
  });

  it("leaves a deferred erasure alone instead of deleting an identity early", async () => {
    const store = {
      begin: vi.fn().mockResolvedValue(state({ status: "deletion_requested", identity: null })),
      confirmStorageAbsence: vi.fn(),
      advance: vi.fn().mockResolvedValue(
        state({ deferrals: ["ebay-provider-authority-pending"] }),
      ),
      finalize: vi.fn(),
    };
    const identity = identityStub();

    const result = await eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage: { remove: vi.fn() }, identity },
    );

    expect(result.deferrals).toEqual(["ebay-provider-authority-pending"]);
    expect(identity.deleteClerkUser).not.toHaveBeenCalled();
    expect(store.finalize).not.toHaveBeenCalled();
  });

  it("takes another pass when an upload raced the fence into the manifest", async () => {
    const late = { bucketId: "message-photos" as const, objectName: "user_384/late.jpg" };
    const store = {
      begin: vi.fn().mockResolvedValue(
        state({ status: "deletion_requested", storageObjects: [storageObject], identity: null }),
      ),
      confirmStorageAbsence: vi.fn().mockResolvedValue(true),
      advance: vi.fn()
        .mockResolvedValueOnce(state({
          deferrals: ["private-storage-objects-pending"],
          storageObjects: [late],
        }))
        .mockResolvedValueOnce(state()),
      finalize: vi.fn().mockResolvedValue(state({ status: "deletion_completed", identity: null })),
    };
    const storage = { remove: vi.fn().mockResolvedValue(undefined) };

    const result = await eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage, identity: identityStub() },
    );

    expect(storage.remove.mock.calls).toEqual([[storageObject], [late]]);
    expect(result.status).toBe("deletion_completed");
  });

  it("resumes the same generation when Storage removal is interrupted", async () => {
    const store = {
      begin: vi.fn().mockResolvedValue(
        state({ status: "deletion_requested", storageObjects: [storageObject], identity: null }),
      ),
      confirmStorageAbsence: vi.fn().mockResolvedValue(true),
      advance: vi.fn().mockResolvedValue(state()),
      finalize: vi.fn().mockResolvedValue(state({ status: "deletion_completed", identity: null })),
    };
    const storage = {
      remove: vi.fn()
        .mockRejectedValueOnce(new Error("interrupted"))
        .mockResolvedValueOnce(undefined),
    };

    const dependencies = { store, storage, identity: identityStub() };
    await expect(eraseAccount({ userId: "user_384", idempotencyKey }, dependencies))
      .rejects.toThrow("interrupted");
    await expect(eraseAccount({ userId: "user_384", idempotencyKey }, dependencies))
      .resolves.toMatchObject({ generationId, status: "deletion_completed" });

    expect(store.begin).toHaveBeenNthCalledWith(1, { userId: "user_384", idempotencyKey });
    expect(store.begin).toHaveBeenNthCalledWith(2, { userId: "user_384", idempotencyKey });
    expect(store.confirmStorageAbsence).toHaveBeenCalledTimes(1);
    expect(store.advance).toHaveBeenCalledTimes(1);
  });

  it("answers a terminal replay without repeating any deletion", async () => {
    const store = {
      begin: vi.fn().mockResolvedValue(state({ status: "deletion_completed", identity: null })),
      confirmStorageAbsence: vi.fn(),
      advance: vi.fn(),
      finalize: vi.fn(),
    };
    const identity = identityStub();

    const result = await eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage: { remove: vi.fn() }, identity },
    );

    expect(result.status).toBe("deletion_completed");
    expect(store.advance).not.toHaveBeenCalled();
    expect(identity.deleteClerkUser).not.toHaveBeenCalled();
  });
});
