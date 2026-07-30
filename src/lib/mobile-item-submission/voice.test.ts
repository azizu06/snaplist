import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareMobileItemSubmission } from "./contract";
import {
  MAX_MOBILE_ITEM_VOICE_BYTES,
  prepareMobileSubmissionVoice,
} from "./voice";

function wav(sampleCount = 160, sampleSeed = 0): Uint8Array {
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  view.setInt16(44, sampleSeed, true);
  return bytes;
}

function file(bytes: Uint8Array, type = "audio/wav"): File {
  return new File([Uint8Array.from(bytes).buffer], "voice.wav", { type });
}

describe("mobile item submission voice", () => {
  it("derives one bounded canonical PCM receipt and canonical locale", async () => {
    const prepared = await prepareMobileSubmissionVoice(
      file(wav()),
      "EN-us",
    );

    expect(prepared).toMatchObject({
      version: 1,
      byteLength: 364,
      durationMs: 10,
      locale: "en-US",
      mediaType: "audio/wav",
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.each([
    ["missing", null],
    ["empty", file(new Uint8Array())],
    ["unsupported media", file(wav(), "audio/mpeg")],
    ["malformed RIFF", file(new Uint8Array([0x52, 0x49, 0x46, 0x46]))],
    ["over duration", file(wav(16_000 * 15 + 1))],
    [
      "over byte ceiling",
      file(new Uint8Array(MAX_MOBILE_ITEM_VOICE_BYTES + 1)),
    ],
  ])("treats %s voice as absent", async (_name, value) => {
    await expect(
      prepareMobileSubmissionVoice(value, "en-US"),
    ).resolves.toBeNull();
  });

  it("binds accepted voice and canonical locale into the v2 fingerprint", async () => {
    const prepare = async (voiceBytes: Uint8Array, locale: string) => {
      const body = new FormData();
      body.append(
        "photo",
        new File(
          [new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer],
          "photo.jpg",
          { type: "image/jpeg" },
        ),
      );
      body.append("voiceContext", file(voiceBytes));
      body.append("voiceContextLocale", locale);
      return prepareMobileItemSubmission(body);
    };

    const original = await prepare(wav(160, 1), "EN-us");
    const canonicalReplay = await prepare(wav(160, 1), "en-US");
    const changedVoice = await prepare(wav(160, 2), "en-US");
    const changedLocale = await prepare(wav(160, 1), "fr-FR");

    expect(original.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalReplay.requestFingerprint).toBe(
      original.requestFingerprint,
    );
    expect(changedVoice.requestFingerprint).not.toBe(
      original.requestFingerprint,
    );
    expect(changedLocale.requestFingerprint).not.toBe(
      original.requestFingerprint,
    );
  });

  it("carries the exact legacy v1 fingerprint beside a new photo-only v2 request", async () => {
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const body = new FormData();
    body.append(
      "photo",
      new File([photo.buffer], "photo.jpg", { type: "image/jpeg" }),
    );
    const prepared = await prepareMobileItemSubmission(body);
    const legacy = createHash("sha256");
    legacy.update("snaplist-mobile-item-submission-v1\0", "utf8");
    legacy.update(
      JSON.stringify({ costBasisCents: null, photoCount: 1 }),
      "utf8",
    );
    legacy.update(`\u00000:${photo.byteLength}:`, "utf8");
    legacy.update(photo);

    expect(prepared.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.legacyRequestFingerprint).toBe(legacy.digest("hex"));
    expect(prepared.legacyRequestFingerprint).not.toBe(
      prepared.requestFingerprint,
    );

    body.append("voiceContext", file(wav()));
    const voiceBearing = await prepareMobileItemSubmission(body);
    expect(voiceBearing.legacyRequestFingerprint).toBeNull();
  });
});
