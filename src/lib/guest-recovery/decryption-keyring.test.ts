import { describe, expect, it } from "vitest";
import { parseGuestRecoveryDecryptionKeyringConfig } from "./decryption-keyring";

const activeKey = new Uint8Array(32).fill(2);
const retiredKey = new Uint8Array(32).fill(1);

describe("guest recovery decryption keyring", () => {
  it("keeps a retired key readable while a new producer key is active", () => {
    const keyring = parseGuestRecoveryDecryptionKeyringConfig({
      activeEncodedKey: Buffer.from(activeKey).toString("base64"),
      activeKeyId: "guest-recovery-v2",
      encodedRetiredKeys: JSON.stringify({
        "guest-recovery-v1": Buffer.from(retiredKey).toString("base64"),
      }),
    });

    expect(keyring.keyFor("guest-recovery-v1")).toEqual(retiredKey);
    expect(keyring.keyFor("guest-recovery-v2")).toEqual(activeKey);
  });
});
