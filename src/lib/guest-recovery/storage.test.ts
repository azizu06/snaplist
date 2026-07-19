import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseGuestClaimStorage } from "./storage";

const bytes = new TextEncoder().encode("encrypted-photo-fixture");
const object = {
  sourcePath: "guest_fixture/item/front.enc",
  destinationPath: "user_account/item/front.enc",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteLength: bytes.byteLength,
  encryption: {
    algorithm: "aes-256-gcm" as const,
    keyId: "guest-recovery-v1",
    nonce: Buffer.alloc(12, 4).toString("base64"),
    tag: Buffer.alloc(16, 5).toString("base64"),
  },
};

function client(input: {
  copyError?: { message: string } | null;
  downloaded?: Uint8Array;
}) {
  const downloadedBytes = input.downloaded ?? bytes;
  const downloadedArrayBuffer = downloadedBytes.buffer.slice(
    downloadedBytes.byteOffset,
    downloadedBytes.byteOffset + downloadedBytes.byteLength,
  ) as ArrayBuffer;
  const copy = vi.fn().mockResolvedValue({ data: {}, error: input.copyError ?? null });
  const download = vi.fn().mockResolvedValue({
    data: new Blob([downloadedArrayBuffer]),
    error: null,
  });
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });
  return {
    client: {
      storage: { from: vi.fn(() => ({ copy, download, remove })) },
    },
    copy,
    download,
    remove,
  };
}

describe("guest private Storage copy verification", () => {
  it("hashes the destination bytes before issuing a verification receipt", async () => {
    const fake = client({});
    const storage = createSupabaseGuestClaimStorage(fake.client);

    await expect(storage.copyAndVerify(object)).resolves.toEqual({
      destinationPath: object.destinationPath,
      sha256: object.sha256,
      byteLength: object.byteLength,
      encryption: object.encryption,
    });
    expect(fake.copy).toHaveBeenCalledWith(object.sourcePath, object.destinationPath);
    expect(fake.download).toHaveBeenCalledWith(object.destinationPath);
  });

  it("accepts an exact destination left by an interrupted retry even when copy reports a conflict", async () => {
    const fake = client({ copyError: { message: "The resource already exists" } });
    const storage = createSupabaseGuestClaimStorage(fake.client);

    await expect(storage.copyAndVerify(object)).resolves.toMatchObject({
      destinationPath: object.destinationPath,
      sha256: object.sha256,
    });
  });

  it("removes a mismatched destination and never returns a receipt", async () => {
    const fake = client({ downloaded: new TextEncoder().encode("wrong") });
    const storage = createSupabaseGuestClaimStorage(fake.client);

    await expect(storage.copyAndVerify(object)).rejects.toThrow(
      /verification failed/i,
    );
    expect(fake.remove).toHaveBeenCalledWith([object.destinationPath]);
  });
});
