import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { createConfiguredMobileItemSubmissionOperations } from "./configured";

const baseInput = {
  supabaseURL: "https://project.supabase.co",
  publishableKey: "sb_publishable_current",
  secretKey: "sb_secret_current",
};
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const jpegSha256 = createHash("sha256").update(jpeg).digest("hex");

describe("configured mobile item submission", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts only current Supabase publishable and secret key formats", () => {
    expect(() => createConfiguredMobileItemSubmissionOperations(baseInput)).not.toThrow();
  });

  it.each([
    {
      name: "legacy service-role JWT",
      input: { ...baseInput, secretKey: "eyJhbGciOiJIUzI1NiJ9.legacy" },
      message: /current Supabase secret key/,
    },
    {
      name: "legacy anon JWT",
      input: { ...baseInput, publishableKey: "eyJhbGciOiJIUzI1NiJ9.legacy" },
      message: /current Supabase publishable key/,
    },
    {
      name: "missing publishable key",
      input: { ...baseInput, publishableKey: "" },
      message: /current Supabase publishable key/,
    },
  ])("rejects $name", ({ input, message }) => {
    expect(() => createConfiguredMobileItemSubmissionOperations(input)).toThrow(message);
  });

  it("does not require or create a service client for verified-guest composition", () => {
    expect(() =>
      createConfiguredMobileItemSubmissionOperations({
        supabaseURL: baseInput.supabaseURL,
        publishableKey: baseInput.publishableKey,
      })
    ).not.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("uses only publishable authenticated-self RPC and Storage with a fresh guest JWT", async () => {
    const secretRpc = vi.fn();
    const guestRpc = vi.fn(async (
      name: string,
      args?: Record<string, unknown>,
    ) => {
      void args;
      if (name === "find_mobile_item_submission_v3") {
        return { data: [], error: null };
      }
      if (name === "begin_mobile_item_submission_v3") {
        return { data: true, error: null };
      }
      if (name === "commit_mobile_item_submission_v3") {
        return {
          data: [{
            denial_reason: null,
            is_replay: false,
            item_id: "33200000-0000-4000-8000-000000000010",
            photo_identity_fingerprint: "c".repeat(64),
            photo_identity_kind: "content_sha256_set_v1",
            photo_receipts: [{
              byte_length: 4,
              content_sha256: jpegSha256,
              media_type: "image/jpeg",
              ordinal: 0,
              storage_path: "guest/path",
            }],
            queue_message_id: 1,
            run_id: "33200000-0000-4000-8000-000000000011",
          }],
          error: null,
        };
      }
      return { data: true, error: null };
    });
    const tokens: string[] = [];
    const mintOperationToken = vi.fn(async () => {
      const token = `fresh-operation-token-${tokens.length + 1}`;
      tokens.push(token);
      return token;
    });
    createClient.mockImplementation(
      (_url: string, key: string, options: { accessToken?: () => Promise<string> }) => {
        if (key === baseInput.secretKey) return { rpc: secretRpc };
        const authorize = async () => {
          if (!options.accessToken) throw new Error("missing authenticated token");
          await options.accessToken();
        };
        return {
          rpc: async (name: string, args: Record<string, unknown>) => {
            await authorize();
            return guestRpc(name, args);
          },
          storage: {
            from: vi.fn(() => ({
              async download() {
                await authorize();
                return { data: new Blob([jpeg], { type: "image/jpeg" }), error: null };
              },
              async remove() {
                await authorize();
                return { data: [], error: null };
              },
              async upload() {
                await authorize();
                return { data: null, error: null };
              },
            })),
          },
        };
      },
    );
    const operations = createConfiguredMobileItemSubmissionOperations(baseInput);

    await expect(operations.submit({
      costBasis: null,
      idempotencyKey: "33200000-0000-4000-8000-000000000001",
      guestRecoveryIdentity: {
        recoveryId: "33200000-0000-4000-8000-000000000003",
        recoveryTokenHash: "b".repeat(64),
      },
      photos: [{
        byteLength: jpeg.byteLength,
        bytes: jpeg,
        contentSha256: jpegSha256,
        mediaType: "image/jpeg",
        ordinal: 0,
      }],
      principal: {
        capabilityId: "33200000-0000-4000-8000-000000000002",
        kind: "verifiedGuest",
        mintOperationToken,
        userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      legacyRequestFingerprint: null,
      requestFingerprint: "a".repeat(64),
      voice: null,
    })).resolves.toMatchObject({ outcome: "created" });

    expect(secretRpc).not.toHaveBeenCalled();
    expect(guestRpc.mock.calls.map(([name]) => name)).toEqual([
      "find_mobile_item_submission_v3",
      "begin_mobile_item_submission_v3",
      "commit_mobile_item_submission_v3",
    ]);
    expect(mintOperationToken).toHaveBeenCalledTimes(5);
    expect(new Set(tokens).size).toBe(5);
    const guestClient = createClient.mock.calls.find(
      ([, key]) => key === baseInput.publishableKey,
    );
    expect(guestClient).toBeDefined();
    expect(
      createClient.mock.calls.some(([, key]) => key === baseInput.secretKey),
    ).toBe(false);
    for (const [, args] of guestRpc.mock.calls) {
      expect(args).not.toHaveProperty("p_user_id");
    }
  });

  it("stops before Storage when capability re-resolution rejects the next operation token", async () => {
    const guestRpc = vi.fn(async (name: string) => ({
      data: name === "find_mobile_item_submission_v3" ? [] : true,
      error: null,
    }));
    const providerStorageCalls = vi.fn();
    const mintOperationToken = vi.fn()
      .mockResolvedValueOnce("lookup-token")
      .mockResolvedValueOnce("begin-token")
      .mockRejectedValue(new Error("Inactive guest capability."));
    createClient.mockImplementation(
      (_url: string, _key: string, options: { accessToken?: () => Promise<string> }) => {
        const authorize = async () => {
          if (!options.accessToken) throw new Error("missing authenticated token");
          await options.accessToken();
        };
        return {
          rpc: async (name: string) => {
            await authorize();
            return guestRpc(name);
          },
          storage: {
            from: vi.fn(() => ({
              async download() {
                await authorize();
                providerStorageCalls("download");
                return { data: new Blob([jpeg]), error: null };
              },
              async remove() {
                await authorize();
                providerStorageCalls("remove");
                return { data: [], error: null };
              },
              async upload() {
                await authorize();
                providerStorageCalls("upload");
                return { data: null, error: null };
              },
            })),
          },
        };
      },
    );
    const operations = createConfiguredMobileItemSubmissionOperations({
      publishableKey: baseInput.publishableKey,
      supabaseURL: baseInput.supabaseURL,
    });

    await expect(operations.submit({
      costBasis: null,
      idempotencyKey: "33200000-0000-4000-8000-000000000021",
      guestRecoveryIdentity: {
        recoveryId: "33200000-0000-4000-8000-000000000023",
        recoveryTokenHash: "c".repeat(64),
      },
      photos: [{
        byteLength: jpeg.byteLength,
        bytes: jpeg,
        contentSha256: jpegSha256,
        mediaType: "image/jpeg",
        ordinal: 0,
      }],
      principal: {
        capabilityId: "33200000-0000-4000-8000-000000000022",
        kind: "verifiedGuest",
        mintOperationToken,
        userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      legacyRequestFingerprint: null,
      requestFingerprint: "d".repeat(64),
      voice: null,
    })).rejects.toThrow(/inactive guest capability/i);

    expect(guestRpc.mock.calls.map(([name]) => name)).toEqual([
      "find_mobile_item_submission_v3",
      "begin_mobile_item_submission_v3",
    ]);
    expect(mintOperationToken).toHaveBeenCalledTimes(4);
    expect(providerStorageCalls).not.toHaveBeenCalled();
  });
});
