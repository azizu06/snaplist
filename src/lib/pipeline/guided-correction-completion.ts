import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  buildPricingEvidenceSnapshotInput,
  pricingEvidenceSnapshotInputSchema,
} from "../pricing-evidence";
import {
  recordGuidedCorrectionProviderUsage,
  type PostCompletionProviderUsage,
} from "../provider-usage/post-completion";
import { buildPredictionLogValues } from "./prediction-log";
import {
  listingCopySchema,
  pipelineResultSchema,
  type PipelineResult,
} from "./types";

export const GUIDED_CORRECTION_CAPABILITY_TTL_MS = 5 * 60 * 1_000;

type GuidedCorrectionAuthorizationRpcName =
  | "authorize_ai_item_guided_correction"
  | "authorize_mobile_guided_correction";
type GuidedCorrectionCompletionRpcName =
  | "complete_guided_review_correction"
  | "complete_mobile_guided_correction"
  | "record_guided_correction_provider_usage";

interface GuidedCorrectionRpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface GuidedCorrectionAuthorizationRpcClient {
  rpc(
    functionName: GuidedCorrectionAuthorizationRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<GuidedCorrectionRpcResult>;
}

/** Fixed privileged capability: no generic table or arbitrary RPC surface. */
export interface GuidedCorrectionCompletionRpcClient {
  rpc(
    functionName: GuidedCorrectionCompletionRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<GuidedCorrectionRpcResult>;
}

export interface GuidedCorrectionCapability {
  token: string;
  expiresAt: string;
}

export interface GuidedCorrectionAttemptIdentity {
  itemId: string;
  listingId: string;
  runId: string;
  expectedRunId: string | null;
  expectedReviewRevision: string;
}

export interface MobileGuidedCorrectionAuthorizationInput
  extends GuidedCorrectionAttemptIdentity {
  claimRunId: string;
  idempotencyKey: string;
  attemptGeneration: number;
}

export interface GuidedCorrectionCompletionInput
  extends GuidedCorrectionAttemptIdentity {
  capabilityToken: string;
  result: PipelineResult;
}

export interface MobileGuidedCorrectionCompletionInput
  extends GuidedCorrectionAttemptIdentity {
  capabilityToken: string;
  idempotencyKey: string;
  attemptGeneration: number;
  commit: {
    itemId: string;
    expectedReviewRevision: string;
    runId: string;
    attributes: Record<string, unknown>;
    identification?: unknown;
    listing: unknown;
    prediction: unknown;
    pricingSnapshot: unknown;
  };
  receipt: Record<string, unknown>;
}

export interface GuidedCorrectionCompletionGateway {
  authorize(
    input: GuidedCorrectionAttemptIdentity,
  ): Promise<GuidedCorrectionCapability>;
  authorizeMobile(
    input: MobileGuidedCorrectionAuthorizationInput,
  ): Promise<GuidedCorrectionCapability>;
  complete(input: GuidedCorrectionCompletionInput): Promise<void>;
  completeMobile(
    input: MobileGuidedCorrectionCompletionInput,
  ): Promise<void>;
  /**
   * Attribute a committed correction's provider spend to the run it corrected.
   *
   * Runs after the correction is durable, so it may fail without costing the
   * seller their work — see reportPostCompletionProviderUsage, which is what
   * both correction paths call this through.
   */
  recordProviderUsage(input: PostCompletionProviderUsage): Promise<void>;
}

interface GuidedCorrectionGatewayDependencies {
  now?: () => number;
  tokenGenerator?: () => string;
}

const uuid = z.string().uuid();
const capabilityTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const attemptIdentitySchema = z
  .object({
    itemId: uuid,
    listingId: uuid,
    runId: uuid,
    expectedRunId: uuid.nullable(),
    expectedReviewRevision: uuid,
  })
  .strict();
const mobileAuthorizationInputSchema = attemptIdentitySchema
  .extend({
    claimRunId: uuid,
    idempotencyKey: uuid,
    attemptGeneration: z.number().int().positive().safe(),
  })
  .strict();
const completionInputSchema = attemptIdentitySchema
  .extend({
    capabilityToken: capabilityTokenSchema,
    result: pipelineResultSchema.refine((value) => value.identification != null, {
      message: "Guided correction requires coherent identification.",
      path: ["identification"],
    }),
  })
  .strict();
const mobileCompletionInputSchema = attemptIdentitySchema
  .extend({
    capabilityToken: capabilityTokenSchema,
    idempotencyKey: uuid,
    attemptGeneration: z.number().int().positive().safe(),
    commit: z
      .object({
        itemId: uuid,
        expectedReviewRevision: uuid,
        runId: uuid,
        attributes: z.record(z.string(), z.unknown()),
        identification: z.unknown().optional(),
        listing: listingCopySchema,
        pricingSnapshot: pricingEvidenceSnapshotInputSchema,
        prediction: z
          .object({
            price: z.number().positive(),
            price_range: z.object({ low: z.number(), high: z.number() }),
            confidence: z.number().min(0).max(1),
            tier_fired: z.string().min(1),
            model: z.string().min(1),
            sources: z.array(z.unknown()),
          })
          .passthrough(),
      })
      .strict(),
    receipt: z.record(z.string(), z.unknown()),
  })
  .strict();
const authorizationResultSchema = z
  .object({ expiresAt: z.string().datetime({ offset: true }) })
  .strict();

function rpcData(operation: string, result: GuidedCorrectionRpcResult): unknown {
  if (result.error) {
    throw new Error(`Guided correction ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

function defaultTokenGenerator(): string {
  return randomBytes(32).toString("base64url");
}

function capabilityRequest(
  dependencies: GuidedCorrectionGatewayDependencies,
): { token: string; expiresAt: string } {
  const token = capabilityTokenSchema.parse(
    (dependencies.tokenGenerator ?? defaultTokenGenerator)(),
  );
  const now = dependencies.now?.() ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Guided correction capability clock is invalid.");
  }
  return {
    token,
    expiresAt: new Date(
      now + GUIDED_CORRECTION_CAPABILITY_TTL_MS,
    ).toISOString(),
  };
}

export async function completeSupabaseMobileGuidedCorrection(
  completionClient: GuidedCorrectionCompletionRpcClient,
  rawInput: MobileGuidedCorrectionCompletionInput,
): Promise<void> {
  const input = mobileCompletionInputSchema.parse(rawInput);
  const response = await completionClient.rpc(
    "complete_mobile_guided_correction",
    {
      p_completion_token: input.capabilityToken,
      p_idempotency_key: input.idempotencyKey,
      p_attempt_generation: input.attemptGeneration,
      p_commit: {
        item_id: input.commit.itemId,
        expected_review_revision: input.commit.expectedReviewRevision,
        run_id: input.commit.runId,
        attributes: input.commit.attributes,
        identification: input.commit.identification ?? null,
        listing: {
          copy: input.commit.listing.fields,
          description: input.commit.listing.description,
          platform: input.commit.listing.platform,
          title: input.commit.listing.title,
        },
        prediction: input.commit.prediction,
        pricing_snapshot: input.commit.pricingSnapshot,
      },
      p_receipt: input.receipt,
    },
  );
  z.literal(true).parse(rpcData("mobile correction completion", response));
}

/**
 * One semantic commit builder for guided correction. The strict TypeScript
 * pricing codec runs here before the fixed service-role completion RPC.
 */
export function createSupabaseGuidedCorrectionCompletionGateway(
  authorizationClient: GuidedCorrectionAuthorizationRpcClient,
  completionClient: GuidedCorrectionCompletionRpcClient,
  dependencies: GuidedCorrectionGatewayDependencies = {},
): GuidedCorrectionCompletionGateway {
  return {
    async authorize(rawInput) {
      const input = attemptIdentitySchema.parse(rawInput);
      const { token, expiresAt } = capabilityRequest(dependencies);
      const response = await authorizationClient.rpc(
        "authorize_ai_item_guided_correction",
        {
          p_completion_run_id: input.runId,
          p_completion_token: token,
          p_expires_at: expiresAt,
          p_expected_review_revision: input.expectedReviewRevision,
          p_expected_run_id: input.expectedRunId,
          p_item_id: input.itemId,
          p_listing_id: input.listingId,
        },
      );
      const authorization = authorizationResultSchema.parse(
        rpcData("authorization", response),
      );
      return { token, expiresAt: authorization.expiresAt };
    },

    async authorizeMobile(rawInput) {
      const input = mobileAuthorizationInputSchema.parse(rawInput);
      const { token, expiresAt } = capabilityRequest(dependencies);
      const response = await authorizationClient.rpc(
        "authorize_mobile_guided_correction",
        {
          p_claim_run_id: input.claimRunId,
          p_idempotency_key: input.idempotencyKey,
          p_attempt_generation: input.attemptGeneration,
          p_completion_run_id: input.runId,
          p_completion_token: token,
          p_expires_at: expiresAt,
          p_expected_review_revision: input.expectedReviewRevision,
          p_expected_run_id: input.expectedRunId,
          p_item_id: input.itemId,
          p_listing_id: input.listingId,
        },
      );
      const authorization = authorizationResultSchema.parse(
        rpcData("mobile authorization", response),
      );
      return { token, expiresAt: authorization.expiresAt };
    },

    async recordProviderUsage(input) {
      await recordGuidedCorrectionProviderUsage(completionClient, input);
    },

    async complete(rawInput) {
      const input = completionInputSchema.parse(rawInput);
      const result = input.result as PipelineResult & {
        identification: NonNullable<PipelineResult["identification"]>;
      };
      const pricingSnapshot = buildPricingEvidenceSnapshotInput(result);
      const response = await completionClient.rpc(
        "complete_guided_review_correction",
        {
          p_completion_token: input.capabilityToken,
          p_commit: {
            expected_review_revision: input.expectedReviewRevision,
            expected_run_id: input.expectedRunId,
            item: {
              attributes: result.attributes,
              condition: result.attributes.condition ?? null,
              identification: result.identification,
            },
            item_id: input.itemId,
            listing: {
              copy: result.listing.fields,
              description: result.listing.description,
              platform: result.listing.platform,
              title: result.listing.title,
            },
            listing_id: input.listingId,
            prediction: buildPredictionLogValues(result, {
              autopilotEnabled: false,
            }),
            pricing_snapshot: pricingSnapshot,
            run_id: input.runId,
          },
        },
      );
      z.literal(true).parse(rpcData("completion", response));
    },

    async completeMobile(rawInput) {
      await completeSupabaseMobileGuidedCorrection(completionClient, rawInput);
    },
  };
}
