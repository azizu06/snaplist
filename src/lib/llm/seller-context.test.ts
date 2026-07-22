import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LLM_ROLES } from "./index";
import {
  SELLER_CONTEXT_TRANSCRIPTION_ROLE,
  resolveSellerContextTranscriber,
  type SellerContextTranscriptionInput,
} from "./seller-context";

function fixedWavBytes(): Uint8Array {
  const samples = 160;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

const voiceBytes = fixedWavBytes();
const verifiedVoice: SellerContextTranscriptionInput = {
  bytes: voiceBytes,
  mediaType: "audio/wav",
  contentSha256: createHash("sha256").update(voiceBytes).digest("hex"),
  durationMs: 10,
  localeHint: "en-US",
  signal: new AbortController().signal,
};

describe("resolveSellerContextTranscriber", () => {
  it("exports sellerContext beside, not inside, the generation roles", () => {
    expect(SELLER_CONTEXT_TRANSCRIPTION_ROLE).toBe("sellerContext");
    expect(LLM_ROLES).not.toContain(SELLER_CONTEXT_TRANSCRIPTION_ROLE);
  });

  it("normalizes configured output and fails open when disabled or failed", async () => {
    let receivedInput: SellerContextTranscriptionInput | undefined;
    const transcriber = resolveSellerContextTranscriber({
      model: {
        async transcribe(input) {
          receivedInput = input;
          return {
            text: `  A\u030A\u0000${"x".repeat(1_100)}  `,
            language: "EN-us",
            requestId: "req_sensitive",
            rawResponse: { provider: "must-not-escape" },
          };
        },
      },
    });

    await expect(transcriber.transcribe(verifiedVoice)).resolves.toEqual({
      kind: "transcribed",
      text: `Å${"x".repeat(999)}`,
      language: "en-US",
    });
    expect(receivedInput).toMatchObject({
      bytes: verifiedVoice.bytes,
      mediaType: "audio/wav",
      contentSha256: verifiedVoice.contentSha256,
      durationMs: verifiedVoice.durationMs,
      localeHint: "en-US",
      signal: expect.any(AbortSignal),
    });

    await expect(
      resolveSellerContextTranscriber().transcribe(verifiedVoice),
    ).resolves.toEqual({ kind: "unsupported" });

    const failed = resolveSellerContextTranscriber({
      model: {
        async transcribe() {
          throw new Error("provider request req_sensitive failed");
        },
      },
    });
    await expect(failed.transcribe(verifiedVoice)).resolves.toEqual({
      kind: "failed",
    });
  });

  it("maps empty and adapter-unavailable output to photos-only outcomes", async () => {
    const empty = resolveSellerContextTranscriber({
      model: {
        async transcribe() {
          return { text: " \n\u0000\t ", language: "en-US" };
        },
      },
    });
    await expect(empty.transcribe(verifiedVoice)).resolves.toEqual({
      kind: "empty",
    });

    const unsupported = resolveSellerContextTranscriber({
      model: {
        async transcribe() {
          return {
            kind: "unsupported" as const,
            requestId: "req_sensitive",
            rawResponse: "must-not-escape",
          };
        },
      },
    });
    await expect(unsupported.transcribe(verifiedVoice)).resolves.toEqual({
      kind: "unsupported",
    });
  });

  it("rejects inputs outside the verified ADR-0011 WAV receipt contract", async () => {
    const transcribe = vi.fn(async () => ({ text: "unused" }));
    const transcriber = resolveSellerContextTranscriber({
      model: { transcribe },
    });
    const unsupportedInputs = [
      { ...verifiedVoice, bytes: new Uint8Array() },
      { ...verifiedVoice, bytes: new Uint8Array(524_289) },
      { ...verifiedVoice, mediaType: "audio/mpeg" },
      { ...verifiedVoice, contentSha256: "not-a-sha256" },
      { ...verifiedVoice, durationMs: 15_001 },
      { ...verifiedVoice, localeHint: "EN-us" },
      { ...verifiedVoice, localeHint: undefined },
    ] as SellerContextTranscriptionInput[];

    for (const input of unsupportedInputs) {
      await expect(transcriber.transcribe(input)).resolves.toEqual({
        kind: "unsupported",
      });
    }
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("aborts the adapter and returns photos-only at the 20-second deadline", async () => {
    vi.useFakeTimers();
    try {
      let adapterSignal: AbortSignal | undefined;
      const transcriber = resolveSellerContextTranscriber({
        model: {
          async transcribe(input) {
            adapterSignal = input.signal;
            return new Promise<never>(() => undefined);
          },
        },
      });
      const settled = vi.fn();
      void transcriber.transcribe(verifiedVoice).then(settled);

      expect(adapterSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(adapterSignal?.aborted).toBe(true);
      expect(settled).toHaveBeenCalledWith({ kind: "timed-out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open on caller cancellation without misreporting the deadline", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const shouldNotRun = vi.fn(async () => ({ text: "must not run" }));
    const transcriber = resolveSellerContextTranscriber({
      model: { transcribe: shouldNotRun },
    });

    await expect(
      transcriber.transcribe({ ...verifiedVoice, signal: preAborted.signal }),
    ).resolves.toEqual({ kind: "failed" });
    expect(shouldNotRun).not.toHaveBeenCalled();

    const caller = new AbortController();
    let adapterSignal: AbortSignal | undefined;
    const inFlight = resolveSellerContextTranscriber({
      model: {
        async transcribe(input) {
          adapterSignal = input.signal;
          return new Promise<never>((_resolve, reject) => {
            input.signal.addEventListener(
              "abort",
              () => reject(new Error("provider abort req_sensitive")),
              { once: true },
            );
          });
        },
      },
    }).transcribe({ ...verifiedVoice, signal: caller.signal });

    caller.abort();
    await expect(inFlight).resolves.toEqual({ kind: "failed" });
    expect(adapterSignal?.aborted).toBe(true);
  });

  it("keeps valid text when provider language is missing, invalid, or oversized", async () => {
    const oversizedLanguage = `x-${Array.from(
      { length: 32 },
      () => "abcdefgh",
    ).join("-")}`;

    for (const language of [
      undefined,
      123 as unknown as string,
      "not_a_language",
      oversizedLanguage,
    ]) {
      const transcriber = resolveSellerContextTranscriber({
        model: {
          async transcribe() {
            return { text: "seller context", language };
          },
        },
      });
      await expect(transcriber.transcribe(verifiedVoice)).resolves.toEqual({
        kind: "transcribed",
        text: "seller context",
        language: null,
      });
    }
  });

  it("repairs unpaired UTF-16 surrogates before returning Unicode scalars", async () => {
    const transcriber = resolveSellerContextTranscriber({
      model: {
        async transcribe() {
          return { text: "seller \ud800 context" };
        },
      },
    });

    await expect(transcriber.transcribe(verifiedVoice)).resolves.toEqual({
      kind: "transcribed",
      text: "seller � context",
      language: null,
    });
  });
});
