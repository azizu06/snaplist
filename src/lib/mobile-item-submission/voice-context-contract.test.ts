import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const contextSchema = z
  .object({
    provenance: z.literal("seller_voice"),
    verification: z.literal("unverified"),
  })
  .strict();

const contractSchema = z
  .object({
    contract: z.literal("snaplist.voice-context"),
    version: z.literal(1),
    status: z.literal("accepted"),
    ownerIssue: z.literal(351),
    publication: z
      .object({
        requiresIssue: z.literal(350),
        requiredAuthorityState: z.literal("merged-into-default-branch"),
        mergeBeforeThis: z.literal(true),
      })
      .strict(),
    capture: z
      .object({
        optional: z.literal(true),
        maximumAssets: z.literal(1),
        primitive: z.literal("AVAudioRecorder"),
        container: z.literal("wav"),
        mediaType: z.literal("audio/wav"),
        codec: z.literal("pcm-s16le"),
        channels: z.literal(1),
        sampleRateHz: z.literal(16_000),
        bitsPerSample: z.literal(16),
        maximumDurationMs: z.literal(15_000),
        maximumBytes: z.literal(524_288),
        fileProtection: z.literal("complete"),
        excludedFromBackup: z.literal(true),
        localRecoveryMaximumHours: z.literal(24),
      })
      .strict(),
    upload: z
      .object({
        transport: z.literal("multipart/form-data"),
        mutation: z.literal("POST /v1/items/runs"),
        idempotencyHeader: z.literal("Idempotency-Key"),
        fileField: z.literal("voiceContext"),
        localeHintField: z.literal("voiceContextLocale"),
        maximumFileParts: z.literal(1),
        separateUploadEndpoint: z.literal(false),
        clientSuppliesDerivedMetadata: z.literal(false),
        invalidVoiceBehavior: z.literal("continue-photos-with-null-receipt"),
        receiptField: z.literal("voiceContext"),
        receiptRequiredNullable: z.literal(true),
        receiptAcceptedShape: z.tuple([
          z.literal("version"),
          z.literal("contentSha256"),
          z.literal("byteLength"),
          z.literal("durationMs"),
          z.literal("mediaType"),
        ]),
        queueCarriesAudio: z.literal(false),
      })
      .strict(),
    identity: z
      .object({
        photoIdentityKind: z.literal("content_sha256_set_v1"),
        voiceAffectsPhotoIdentity: z.literal(false),
        voiceAffectsAiItemCreditIdentity: z.literal(false),
        voiceAffectsRequestFingerprint: z.literal(true),
        requestFingerprintVersion: z.literal("snaplist-mobile-item-submission-v2"),
        requestVoiceShape: z.tuple([
          z.literal("version"),
          z.literal("contentSha256"),
          z.literal("byteLength"),
          z.literal("durationMs"),
          z.literal("mediaType"),
          z.literal("localeHint"),
        ]),
        transcriptAffectsRequestFingerprint: z.literal(false),
        changedVoiceWithAcceptedIdempotencyKey: z.literal("conflict"),
        changedLocaleWithAcceptedIdempotencyKey: z.literal("conflict"),
      })
      .strict(),
    transcription: z
      .object({
        role: z.literal("sellerContext"),
        resolverKind: z.literal("transcription-model"),
        generationRole: z.literal(false),
        disabledByDefault: z.literal(true),
        attemptDeadlineMs: z.literal(20_000),
        maximumBillableAttemptsPerLogicalRun: z.literal(1),
        maximumTranscriptUnicodeScalars: z.literal(1_000),
        maximumTranscriptUtf8Bytes: z.literal(4_096),
        languageOutput: z.literal("canonical-bcp47-or-null"),
        maximumLanguageTagUtf8Bytes: z.literal(255),
        invalidLanguageOutputBehavior: z.literal("null"),
        languageNormalizationMatrix: z.tuple([
          z
            .object({
              input: z.literal("missing"),
              normalizedLanguage: z.null(),
              transcriptOutcome: z.literal("transcribed"),
            })
            .strict(),
          z
            .object({
              input: z.literal("invalid"),
              normalizedLanguage: z.null(),
              transcriptOutcome: z.literal("transcribed"),
            })
            .strict(),
          z
            .object({
              input: z.literal("oversized"),
              normalizedLanguage: z.null(),
              transcriptOutcome: z.literal("transcribed"),
            })
            .strict(),
          z
            .object({
              input: z.literal("valid-canonical"),
              normalizedLanguage: z.literal("en-US"),
              transcriptOutcome: z.literal("transcribed"),
            })
            .strict(),
        ]),
        providerConstructedByCaller: z.literal(false),
        providerModelFrozenByContract: z.literal(false),
      })
      .strict(),
    authority: z
      .object({
        provenance: z.literal("seller_voice"),
        verification: z.literal("unverified"),
        mayEnrich: z.tuple([
          z.literal("seller-stated-condition-note"),
          z.literal("editable-title-copy"),
          z.literal("editable-description-copy"),
          z.literal("review-prompt"),
        ]),
        mayNotOverride: z.tuple([
          z.literal("photo-or-catalog-identity"),
          z.literal("pricing-evidence"),
          z.literal("composite-confidence"),
          z.literal("marketplace-truth"),
          z.literal("seller-confirmation"),
        ]),
        treatedAsInstructions: z.literal(false),
      })
      .strict(),
    retention: z
      .object({
        rawAudioPurpose: z.literal("temporary-transcription-input"),
        rawAudioDeletedAfterTerminalTranscriptionOutcome: z.literal(true),
        rawAudioMaximumServerHours: z.literal(24),
        rawAudioCopiedToDurableItem: z.literal(false),
        transcriptOwnedBy: z.literal("seller"),
        transcriptFollowsGuestClaim: z.literal(true),
        transcriptDeletedWithVoiceContext: z.literal(true),
        transcriptDeletedWithItem: z.literal(true),
        transcriptDeletedWithAccount: z.literal(true),
        languageTagRequiresTranscript: z.literal(true),
        languageTagFollowsGuestClaim: z.literal(true),
        languageTagDeletedWithVoiceContext: z.literal(true),
        languageTagDeletedWithItem: z.literal(true),
        languageTagDeletedWithAccount: z.literal(true),
        externalProviderRetentionRequiresActivationDisclosure: z.literal(true),
      })
      .strict(),
    telemetry: z
      .object({
        rawProviderMessagesPersisted: z.literal(false),
        providerRequestIdPersisted: z.literal(false),
        perRunFields: z.tuple([
          z.literal("adapterConfigId"),
          z.literal("modelConfigId"),
          z.literal("outcome"),
          z.literal("elapsedMs"),
          z.literal("billedAudioSeconds"),
          z.literal("cost"),
        ]),
        perRunTelemetryFollowsItemAccountDeletion: z.literal(true),
        deidentifiedAggregateMayPersist: z.literal(true),
      })
      .strict(),
    outcomeMatrix: z.array(
      z
        .object({
          outcome: z.enum([
            "missing",
            "skipped",
            "deleted",
            "permission-denied",
            "interrupted",
            "canceled",
            "invalid",
            "empty",
            "unsupported",
            "timed-out",
            "failed",
            "transcribed",
          ]),
          continuePhotos: z.literal(true),
          sellerContext: contextSchema.nullable(),
        })
        .strict(),
    ),
    excluded: z.array(z.string()).min(1),
  })
  .strict();

const contract = contractSchema.parse(
  JSON.parse(
    readFileSync(
      resolve("docs/contracts/voice-context-v1.json"),
      "utf8",
    ),
  ),
);

describe("voice-context V1 authority", () => {
  it("keeps voice bounded, optional, and separate from photo/accounting identity", () => {
    expect(contract.capture).toMatchObject({
      optional: true,
      maximumAssets: 1,
      maximumDurationMs: 15_000,
      maximumBytes: 524_288,
    });
    expect(contract.identity).toMatchObject({
      voiceAffectsPhotoIdentity: false,
      voiceAffectsAiItemCreditIdentity: false,
      voiceAffectsRequestFingerprint: true,
      transcriptAffectsRequestFingerprint: false,
      requestVoiceShape: [
        "version",
        "contentSha256",
        "byteLength",
        "durationMs",
        "mediaType",
        "localeHint",
      ],
      changedLocaleWithAcceptedIdempotencyKey: "conflict",
    });
    expect(contract.publication).toEqual({
      requiresIssue: 350,
      requiredAuthorityState: "merged-into-default-branch",
      mergeBeforeThis: true,
    });
    expect(contract.upload).toEqual({
      transport: "multipart/form-data",
      mutation: "POST /v1/items/runs",
      idempotencyHeader: "Idempotency-Key",
      fileField: "voiceContext",
      localeHintField: "voiceContextLocale",
      maximumFileParts: 1,
      separateUploadEndpoint: false,
      clientSuppliesDerivedMetadata: false,
      invalidVoiceBehavior: "continue-photos-with-null-receipt",
      receiptField: "voiceContext",
      receiptRequiredNullable: true,
      receiptAcceptedShape: [
        "version",
        "contentSha256",
        "byteLength",
        "durationMs",
        "mediaType",
      ],
      queueCarriesAudio: false,
    });
  });

  it("routes every missing or failed voice outcome through photos-only processing", () => {
    const nonTranscriptOutcomes = contract.outcomeMatrix.filter(
      ({ outcome }) => outcome !== "transcribed",
    );

    expect(nonTranscriptOutcomes.map(({ outcome }) => outcome)).toEqual([
      "missing",
      "skipped",
      "deleted",
      "permission-denied",
      "interrupted",
      "canceled",
      "invalid",
      "empty",
      "unsupported",
      "timed-out",
      "failed",
    ]);
    expect(nonTranscriptOutcomes).toHaveLength(11);
    expect(
      nonTranscriptOutcomes.every(
        ({ continuePhotos, sellerContext }) =>
          continuePhotos && sellerContext === null,
      ),
    ).toBe(true);
  });

  it("allows only a bounded unverified transcript to become seller context", () => {
    const transcript = contract.outcomeMatrix.find(
      ({ outcome }) => outcome === "transcribed",
    );

    expect(transcript).toEqual({
      outcome: "transcribed",
      continuePhotos: true,
      sellerContext: {
        provenance: "seller_voice",
        verification: "unverified",
      },
    });
    expect(contract.transcription).toMatchObject({
      role: "sellerContext",
      disabledByDefault: true,
      maximumBillableAttemptsPerLogicalRun: 1,
      maximumTranscriptUnicodeScalars: 1_000,
      maximumTranscriptUtf8Bytes: 4_096,
      languageOutput: "canonical-bcp47-or-null",
      maximumLanguageTagUtf8Bytes: 255,
      invalidLanguageOutputBehavior: "null",
    });
    expect(contract.transcription.languageNormalizationMatrix).toEqual([
      {
        input: "missing",
        normalizedLanguage: null,
        transcriptOutcome: "transcribed",
      },
      {
        input: "invalid",
        normalizedLanguage: null,
        transcriptOutcome: "transcribed",
      },
      {
        input: "oversized",
        normalizedLanguage: null,
        transcriptOutcome: "transcribed",
      },
      {
        input: "valid-canonical",
        normalizedLanguage: "en-US",
        transcriptOutcome: "transcribed",
      },
    ]);
    expect(contract.authority).toEqual({
      provenance: "seller_voice",
      verification: "unverified",
      mayEnrich: [
        "seller-stated-condition-note",
        "editable-title-copy",
        "editable-description-copy",
        "review-prompt",
      ],
      mayNotOverride: [
        "photo-or-catalog-identity",
        "pricing-evidence",
        "composite-confidence",
        "marketplace-truth",
        "seller-confirmation",
      ],
      treatedAsInstructions: false,
    });
  });

  it("separates temporary raw-audio deletion from seller-owned transcript deletion", () => {
    expect(contract.retention).toMatchObject({
      rawAudioDeletedAfterTerminalTranscriptionOutcome: true,
      rawAudioMaximumServerHours: 24,
      rawAudioCopiedToDurableItem: false,
      transcriptOwnedBy: "seller",
      transcriptFollowsGuestClaim: true,
      transcriptDeletedWithVoiceContext: true,
      transcriptDeletedWithItem: true,
      transcriptDeletedWithAccount: true,
      languageTagRequiresTranscript: true,
      languageTagFollowsGuestClaim: true,
      languageTagDeletedWithVoiceContext: true,
      languageTagDeletedWithItem: true,
      languageTagDeletedWithAccount: true,
    });
    expect(contract.retention.languageTagFollowsGuestClaim).toBe(
      contract.retention.transcriptFollowsGuestClaim,
    );
    expect(contract.retention.languageTagDeletedWithVoiceContext).toBe(
      contract.retention.transcriptDeletedWithVoiceContext,
    );
    expect(contract.retention.languageTagDeletedWithItem).toBe(
      contract.retention.transcriptDeletedWithItem,
    );
    expect(contract.retention.languageTagDeletedWithAccount).toBe(
      contract.retention.transcriptDeletedWithAccount,
    );
    expect(contract.telemetry).toEqual({
      rawProviderMessagesPersisted: false,
      providerRequestIdPersisted: false,
      perRunFields: [
        "adapterConfigId",
        "modelConfigId",
        "outcome",
        "elapsedMs",
        "billedAudioSeconds",
        "cost",
      ],
      perRunTelemetryFollowsItemAccountDeletion: true,
      deidentifiedAggregateMayPersist: true,
    });
  });
});
