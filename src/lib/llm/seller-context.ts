import {
  canonicalizeScoutGuidanceLocale as canonicalizeBcp47LanguageTag,
} from "../scout-guidance/contract";
import {
  isSellerContextTranscriptionEnabled,
  resolveProvider,
  resolveTranscriptionModel,
  resolveTranscriptionModelId,
  sellerContextTranscriptionConfigError,
  SellerContextTranscriptionConfigurationError,
} from "./registry";
import { recordTranscriptionUsage } from "../provider-usage/collector";
import type { ProviderUsageTranscriptionTotals } from "../provider-usage/record";

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
      providerContacted: true;
    }
  | {
      kind: "empty" | "unsupported" | "timed-out" | "failed";
      providerContacted: boolean;
    };

export type SellerContextTranscriptionAttempt =
  ProviderUsageTranscriptionTotals & {
    role: typeof SELLER_CONTEXT_TRANSCRIPTION_ROLE;
    calls: 1;
    chargedUsd: null;
  };

export interface SellerContextTranscriber {
  readonly transcriptionAttempt?: SellerContextTranscriptionAttempt;
  transcribe(
    input: SellerContextTranscriptionInput,
  ): Promise<SellerContextTranscriptionResult>;
}

export interface SellerContextTranscriptionModel {
  readonly transcriptionAttempt?: SellerContextTranscriptionAttempt;
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

export function createRoleKeyedSellerContextTranscriptionModel(): SellerContextTranscriptionModel {
  const env = process.env;
  const configurationError = sellerContextTranscriptionConfigError(env);
  if (configurationError) {
    throw new SellerContextTranscriptionConfigurationError(configurationError);
  }
  const provider = isSellerContextTranscriptionEnabled(env)
    ? resolveProvider(env)
    : null;
  const modelId = provider
    ? resolveTranscriptionModelId(SELLER_CONTEXT_TRANSCRIPTION_ROLE, {
        provider,
        env,
      })
    : null;
  const transcriptionAttempt =
    provider === "openai" && modelId
      ? ({
          role: SELLER_CONTEXT_TRANSCRIPTION_ROLE,
          provider,
          model: modelId,
          calls: 1,
          chargedUsd: null,
        } satisfies SellerContextTranscriptionAttempt)
      : undefined;
  return {
    ...(transcriptionAttempt ? { transcriptionAttempt } : {}),
    async transcribe(input) {
      const model = await resolveTranscriptionModel(
        SELLER_CONTEXT_TRANSCRIPTION_ROLE,
      );
      if (!model) return { kind: "unsupported" };
      const { experimental_transcribe: transcribe } = await import("ai");
      // Count the attempt immediately before the paid boundary. The installed
      // API exposes neither token usage nor charge data, so provider/model/call
      // count is the complete honest receipt even when the provider rejects.
      recordTranscriptionUsage({
        role: SELLER_CONTEXT_TRANSCRIPTION_ROLE,
        provider: model.provider,
        model: model.modelId,
        chargedUsd: null,
      });
      const result = await transcribe({
        model: model.model,
        audio: input.bytes,
        abortSignal: input.signal,
        maxRetries: 0,
      });
      return { text: result.text, language: result.language };
    },
  };
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
        return { kind: "unsupported", providerContacted: false };
      },
    };
  }

  const model = options.model;
  return {
    ...(model.transcriptionAttempt
      ? { transcriptionAttempt: model.transcriptionAttempt }
      : {}),
    async transcribe(input) {
      if (!isVerifiedVoiceInput(input)) {
        return { kind: "unsupported", providerContacted: false };
      }
      if (input.signal.aborted) {
        return { kind: "failed", providerContacted: false };
      }
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
        if (output === timedOut) {
          return { kind: "timed-out", providerContacted: true };
        }
        if (output === callerCancelled) {
          return { kind: "failed", providerContacted: true };
        }
        if ("kind" in output) {
          return { kind: "unsupported", providerContacted: false };
        }
        const text = normalizeTranscript(output.text);
        if (!text) return { kind: "empty", providerContacted: true };
        return {
          kind: "transcribed",
          text,
          language: normalizeLanguage(output.language),
          providerContacted: true,
        };
      } catch (error) {
        if (error instanceof SellerContextTranscriptionConfigurationError) {
          throw error;
        }
        return { kind: "failed", providerContacted: true };
      } finally {
        if (deadline) clearTimeout(deadline);
        input.signal.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}
