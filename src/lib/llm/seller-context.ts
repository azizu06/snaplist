import {
  canonicalizeScoutGuidanceLocale as canonicalizeBcp47LanguageTag,
} from "../scout-guidance/contract";

const MAXIMUM_TRANSCRIPT_UNICODE_SCALARS = 1_000;
const MAXIMUM_TRANSCRIPT_UTF8_BYTES = 4_096;
const MAXIMUM_AUDIO_BYTES = 524_288;
const MAXIMUM_AUDIO_DURATION_MS = 15_000;
const MAXIMUM_LANGUAGE_TAG_UTF8_BYTES = 255;
const TRANSCRIPTION_DEADLINE_MS = 20_000;
const utf8Encoder = new TextEncoder();
const timedOut = Symbol("seller-context-transcription-timed-out");
const callerCancelled = Symbol("seller-context-transcription-caller-cancelled");

export const SELLER_CONTEXT_TRANSCRIPTION_ROLE = "sellerContext" as const;

export type CanonicalLanguageTag = string & {
  readonly __brand: "CanonicalLanguageTag";
};

export interface SellerContextTranscriptionInput {
  bytes: Uint8Array;
  mediaType: "audio/wav";
  contentSha256: string;
  durationMs: number;
  localeHint: string | null;
  signal: AbortSignal;
}

export type SellerContextTranscriptionResult =
  | {
      kind: "transcribed";
      text: string;
      language: CanonicalLanguageTag | null;
    }
  | { kind: "empty" | "unsupported" | "timed-out" | "failed" };

export interface SellerContextTranscriber {
  transcribe(
    input: SellerContextTranscriptionInput,
  ): Promise<SellerContextTranscriptionResult>;
}

export interface SellerContextTranscriptionModel {
  transcribe(input: SellerContextTranscriptionInput): Promise<
    | {
        text: string;
        language?: string | null;
      }
    | { kind: "unsupported" }
  >;
}

export interface ResolveSellerContextTranscriberOptions {
  model?: SellerContextTranscriptionModel;
}

function normalizeTranscript(text: string): string {
  const normalized = text
    .toWellFormed()
    .normalize("NFC")
    .replace(/\p{Cc}/gu, "")
    .trim();
  let bounded = "";
  let unicodeScalars = 0;
  let utf8Bytes = 0;

  for (const scalar of normalized) {
    const scalarBytes = utf8Encoder.encode(scalar).byteLength;
    if (
      unicodeScalars === MAXIMUM_TRANSCRIPT_UNICODE_SCALARS ||
      utf8Bytes + scalarBytes > MAXIMUM_TRANSCRIPT_UTF8_BYTES
    ) {
      break;
    }
    bounded += scalar;
    unicodeScalars += 1;
    utf8Bytes += scalarBytes;
  }

  return bounded.trim();
}

function isVerifiedVoiceInput(input: SellerContextTranscriptionInput): boolean {
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > MAXIMUM_AUDIO_BYTES ||
    input.mediaType !== "audio/wav" ||
    !/^[a-f0-9]{64}$/.test(input.contentSha256) ||
    !Number.isInteger(input.durationMs) ||
    input.durationMs <= 0 ||
    input.durationMs > MAXIMUM_AUDIO_DURATION_MS ||
    !(input.signal instanceof AbortSignal)
  ) {
    return false;
  }
  if (input.localeHint === null) return true;
  if (typeof input.localeHint !== "string") return false;
  return (
    canonicalizeBcp47LanguageTag(input.localeHint) === input.localeHint &&
    utf8Encoder.encode(input.localeHint).byteLength <=
      MAXIMUM_LANGUAGE_TAG_UTF8_BYTES
  );
}

function normalizeLanguage(language: unknown): CanonicalLanguageTag | null {
  if (typeof language !== "string" || !language) return null;
  const canonical = canonicalizeBcp47LanguageTag(language);
  if (
    !canonical ||
    utf8Encoder.encode(canonical).byteLength > MAXIMUM_LANGUAGE_TAG_UTF8_BYTES
  ) {
    return null;
  }
  return canonical as CanonicalLanguageTag;
}

export function resolveSellerContextTranscriber(
  options: ResolveSellerContextTranscriberOptions = {},
): SellerContextTranscriber {
  if (!options.model) {
    return {
      async transcribe() {
        return { kind: "unsupported" };
      },
    };
  }

  const model = options.model;
  return {
    async transcribe(input) {
      if (!isVerifiedVoiceInput(input)) return { kind: "unsupported" };
      if (input.signal.aborted) return { kind: "failed" };
      const deadlineController = new AbortController();
      let cancelFromCaller: (() => void) | undefined;
      const callerCancellation = new Promise<typeof callerCancelled>((resolve) => {
        cancelFromCaller = () => resolve(callerCancelled);
      });
      const abortFromCaller = () => {
        cancelFromCaller?.();
        deadlineController.abort(input.signal.reason);
      };
      input.signal.addEventListener("abort", abortFromCaller, { once: true });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<typeof timedOut>((resolve) => {
          deadline = setTimeout(() => {
            resolve(timedOut);
            deadlineController.abort();
          }, TRANSCRIPTION_DEADLINE_MS);
        });
        const output = await Promise.race([
          model.transcribe({ ...input, signal: deadlineController.signal }),
          timeout,
          callerCancellation,
        ]);
        if (output === timedOut) return { kind: "timed-out" };
        if (output === callerCancelled) return { kind: "failed" };
        if ("kind" in output) return { kind: "unsupported" };
        const text = normalizeTranscript(output.text);
        if (!text) return { kind: "empty" };
        return {
          kind: "transcribed",
          text,
          language: normalizeLanguage(output.language),
        };
      } catch {
        return { kind: "failed" };
      } finally {
        if (deadline) clearTimeout(deadline);
        input.signal.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}
