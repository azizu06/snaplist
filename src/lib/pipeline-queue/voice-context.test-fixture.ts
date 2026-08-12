import { createHash } from "node:crypto";
import type { PipelineWorkerContext } from "./worker-store";

type VoiceReceipt = NonNullable<PipelineWorkerContext["voice"]>["receipt"];

function verifiedWav(durationMs: number): Uint8Array {
  const dataBytes = Math.round((16_000 * 2 * durationMs) / 1_000);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  bytes.set(new TextEncoder().encode("fmt "), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

export function createVerifiedVoiceFixture(input: {
  durationMs?: number;
  receipt?: Partial<VoiceReceipt>;
} = {}): { bytes: Uint8Array; receipt: VoiceReceipt } {
  const durationMs = input.durationMs ?? 100;
  const bytes = verifiedWav(durationMs);
  return {
    bytes,
    receipt: {
      version: 1,
      storagePath: "user_a/intake/voice.wav",
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      durationMs,
      locale: "en-US",
      mediaType: "audio/wav",
      ...input.receipt,
    },
  };
}
