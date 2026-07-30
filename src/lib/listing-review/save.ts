import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ITEM_CONDITIONS, type ItemCondition } from "@/lib/items/condition";
import { parsePriceOverride } from "@/lib/pipeline/autopilot";
import {
  createSupabaseGuidedCorrectionCompletionGateway,
  type GuidedCorrectionCompletionRpcClient,
} from "@/lib/pipeline/guided-correction-completion";
import {
  createSupabaseReviewRegenerationStore,
  parseIdentityCorrections,
  regenerateReviewListing,
  type RegenerateReviewListingDependencies,
  type RegenerateReviewListingInput,
  type RegenerateReviewListingResult,
  type ReviewRegenerationStore,
} from "@/lib/pipeline/review-regeneration";

export interface ListingReviewSpecificIntent {
  name: string;
  value: string;
}

export interface ListingReviewSaveIntent {
  expectedReviewRevision: string;
  title: string;
  description: string;
  condition: ItemCondition;
  specifics: ListingReviewSpecificIntent[];
  sellerPriceOverride: number | null;
}

const trimmedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

type ReservedSpecificKey =
  | "brand"
  | "model"
  | "category"
  | "condition"
  | "isbn"
  | "upc";

function reservedSpecificKey(name: string): ReservedSpecificKey | null {
  switch (name.toLocaleLowerCase("en-US")) {
    case "brand":
      return "brand";
    case "model":
      return "model";
    case "category":
    case "type":
      return "category";
    case "condition":
      return "condition";
    case "isbn":
      return "isbn";
    case "upc":
      return "upc";
    default:
      return null;
  }
}

function canonicalReservedSpecificName(key: ReservedSpecificKey): string {
  switch (key) {
    case "brand":
      return "Brand";
    case "model":
      return "Model";
    case "category":
      return "Type";
    case "condition":
      return "Condition";
    case "isbn":
      return "ISBN";
    case "upc":
      return "UPC";
  }
}

function normalizeReservedSpecifics(
  intent: ListingReviewSaveIntent,
): ListingReviewSaveIntent {
  const identity = parseIdentityCorrections({
    brand: specificValue(intent.specifics, "brand") ?? "",
    model: specificValue(intent.specifics, "model") ?? "",
    category: specificValue(intent.specifics, "category") ?? "",
    condition: intent.condition,
    isbn: specificValue(intent.specifics, "isbn") ?? "",
    upc: specificValue(intent.specifics, "upc") ?? "",
    specifications: "",
  });
  return {
    ...intent,
    specifics: intent.specifics.map((specific) => {
      const key = reservedSpecificKey(specific.name);
      if (!key) return specific;
      const value = key === "condition"
        ? intent.condition
        : identity[key] ?? specific.value;
      return {
        name: canonicalReservedSpecificName(key),
        value,
      };
    }),
  };
}

const sellerPriceOverrideSchema = z.unknown().transform((value, context) => {
  try {
    return parsePriceOverride(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message:
        error instanceof Error
          ? error.message
          : "Seller price override is invalid.",
    });
    return z.NEVER;
  }
});

export const listingReviewSaveIntentSchema = z
  .object({
    expectedReviewRevision: z.string().uuid(),
    title: trimmedText(80),
    description: trimmedText(20_000),
    condition: z.enum(ITEM_CONDITIONS),
    specifics: z
      .array(
        z
          .object({
            name: trimmedText(65),
            value: trimmedText(500),
          })
          .strict(),
      )
      .max(50),
    sellerPriceOverride: sellerPriceOverrideSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    const names = new Set<string>();
    intent.specifics.forEach((specific, index) => {
      const reservedKey = reservedSpecificKey(specific.name);
      const name = reservedKey
        ? `reserved:${reservedKey}`
        : specific.name.toLocaleLowerCase("en-US");
      if (names.has(name)) {
        context.addIssue({
          code: "custom",
          message: reservedKey
            ? "Reserved item-specific aliases cannot be combined."
            : "Item-specific names must be unique.",
          path: ["specifics", index, "name"],
        });
      }
      names.add(name);
    });
  })
  .transform((intent, context) => {
    try {
      return normalizeReservedSpecifics(intent);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error
          ? error.message
          : "Reserved item specifics are invalid.",
        path: ["specifics"],
      });
      return z.NEVER;
    }
  });

export const listingReviewSaveReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    itemId: z.string().uuid(),
    listingId: z.string().uuid(),
    reviewRevision: z.string().uuid(),
  })
  .strict();

export type ListingReviewSaveReceipt = z.infer<
  typeof listingReviewSaveReceiptSchema
>;

export interface ListingReviewSaveSnapshot {
  itemId: string;
  attributes: unknown;
  specifics: Record<string, string>;
}

const listingReviewSaveSnapshotSchema = z
  .object({
    itemId: z.string().uuid(),
    attributes: z.unknown(),
    specifics: z.record(z.string(), z.string()),
  })
  .strict();

const saveResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("completed"),
      receipt: listingReviewSaveReceiptSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("regeneration"),
      snapshot: listingReviewSaveSnapshotSchema,
    })
    .strict(),
  z.object({ state: z.literal("in_progress") }).strict(),
]);

type ListingReviewSaveResult = z.infer<typeof saveResultSchema>;

export interface ListingReviewSaveOperation {
  runId: string;
  idempotencyKey: string;
  intent: ListingReviewSaveIntent;
  userId: string;
  bearerToken: string;
  mintOperationToken?: () => Promise<string>;
}

export interface ListingReviewSaveDataClient {
  execute(input: ListingReviewSaveOperation): Promise<ListingReviewSaveResult>;
  release(input: ListingReviewSaveOperation): Promise<void>;
}

export interface ListingReviewSaveRegenerator {
  regenerate(
    input: ListingReviewSaveOperation & {
      snapshot: ListingReviewSaveSnapshot;
    },
  ): Promise<void>;
}

export interface ListingReviewSaver {
  save(input: ListingReviewSaveOperation): Promise<ListingReviewSaveReceipt>;
}

export class ListingReviewSaveInProgressError extends Error {
  constructor() {
    super("This save is already in progress. Try again.");
  }
}

export class ListingReviewStaleError extends Error {
  constructor() {
    super("This review changed. Reload and try again.");
  }
}

export class ListingReviewIdempotencyConflictError extends Error {
  constructor() {
    super(
      "This Idempotency-Key is already bound to different review edits.",
    );
  }
}

export class ListingReviewNotEditableError extends Error {
  constructor() {
    super("A published listing cannot be changed from review.");
  }
}

export class ListingReviewSaveDataError extends Error {
  constructor(message = "Listing Review save failed.") {
    super(message);
  }
}

interface ListingReviewSaveRpcError {
  message: string;
}

interface ListingReviewSaveRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: ListingReviewSaveRpcError | null }>;
}

function operationArguments(operation: ListingReviewSaveOperation) {
  return {
    p_run_id: operation.runId,
    p_idempotency_key: operation.idempotencyKey,
    p_expected_review_revision: operation.intent.expectedReviewRevision,
    p_title: operation.intent.title,
    p_description: operation.intent.description,
    p_condition: operation.intent.condition,
    p_specifics: operation.intent.specifics,
    p_price_override: operation.intent.sellerPriceOverride,
  };
}

function mapDataError(error: ListingReviewSaveRpcError): Error {
  if (error.message.includes("This review changed. Reload and try again.")) {
    return new ListingReviewStaleError();
  }
  if (
    error.message.includes(
      "This Idempotency-Key is already bound to different review edits.",
    )
  ) {
    return new ListingReviewIdempotencyConflictError();
  }
  if (
    error.message.includes(
      "A published listing cannot be changed from review.",
    )
  ) {
    return new ListingReviewNotEditableError();
  }
  return new ListingReviewSaveDataError();
}

function isStaleRegenerationError(error: unknown): error is Error {
  return error instanceof Error
    && [
      "This review changed. Reload and try again.",
      "Review changed. Reload and try again.",
      "Guided correction authority changed.",
    ].some((message) => error.message.includes(message));
}

function isNotEditableRegenerationError(error: unknown): error is Error {
  return error instanceof Error
    && [
      "A published listing cannot be regenerated from review.",
      "Editable eBay listing not found.",
    ].some((message) => error.message.includes(message));
}

async function operationToken(
  operation: ListingReviewSaveOperation,
): Promise<string> {
  return operation.mintOperationToken
    ? operation.mintOperationToken()
    : operation.bearerToken;
}

export function createListingReviewSaveDataClient(
  clientForBearer: (bearerToken: string) => ListingReviewSaveRpcClient,
): ListingReviewSaveDataClient {
  return {
    async execute(operation) {
      const bearer = await operationToken(operation);
      const result = await clientForBearer(bearer).rpc(
        "save_mobile_listing_review",
        operationArguments(operation),
      );
      if (result.error) throw mapDataError(result.error);
      const parsed = saveResultSchema.safeParse(result.data);
      if (!parsed.success) throw new ListingReviewSaveDataError();
      return parsed.data;
    },
    async release(operation) {
      const bearer = await operationToken(operation);
      const result = await clientForBearer(bearer).rpc(
        "claim_mobile_listing_review_save",
        {
          p_action: "fail",
          ...operationArguments(operation),
        },
      );
      if (result.error) throw mapDataError(result.error);
    },
  };
}

type RegenerateListing = (
  store: ReviewRegenerationStore,
  input: RegenerateReviewListingInput,
  dependencies?: RegenerateReviewListingDependencies,
) => Promise<RegenerateReviewListingResult>;

interface ListingReviewSaveRegeneratorDependencies {
  clientForBearer(bearerToken: string): SupabaseClient;
  completionClient: GuidedCorrectionCompletionRpcClient;
  regenerate?: RegenerateListing;
  now?: () => number;
  tokenGenerator?: () => string;
}

function stringAttribute(
  attributes: Record<string, unknown>,
  key: string,
): string {
  return typeof attributes[key] === "string" ? attributes[key] : "";
}

function specificValue(
  specifics: ListingReviewSpecificIntent[] | Record<string, string>,
  name: string,
): string | undefined {
  const entries = Array.isArray(specifics)
    ? specifics.map(({ name: key, value }) => [key, value] as const)
    : Object.entries(specifics);
  const reservedKey = reservedSpecificKey(name);
  return entries.find(
    ([key]) => reservedKey
      ? reservedSpecificKey(key) === reservedKey
      : key.localeCompare(name, "en-US", { sensitivity: "base" }) === 0,
  )?.[1];
}

function correctedIdentityValue(
  operation: ListingReviewSaveOperation & {
    snapshot: ListingReviewSaveSnapshot;
  },
  attributes: Record<string, unknown>,
  name: string,
): string {
  const staged = specificValue(operation.intent.specifics, name);
  if (staged !== undefined) return staged;
  if (specificValue(operation.snapshot.specifics, name) !== undefined) return "";
  return stringAttribute(attributes, name);
}

export function createListingReviewSaveRegenerator(
  dependencies: ListingReviewSaveRegeneratorDependencies,
): ListingReviewSaveRegenerator {
  return {
    async regenerate(operation) {
      const bearer = await operationToken(operation);
      const supabase = dependencies.clientForBearer(bearer);
      const guidedCorrection =
        createSupabaseGuidedCorrectionCompletionGateway(
          supabase,
          dependencies.completionClient,
          {
            now: dependencies.now,
            tokenGenerator: dependencies.tokenGenerator,
          },
        );
      const attributes =
        operation.snapshot.attributes
        && typeof operation.snapshot.attributes === "object"
        && !Array.isArray(operation.snapshot.attributes)
          ? operation.snapshot.attributes as Record<string, unknown>
          : {};
      const currentSpecs = Array.isArray(attributes.specs)
        ? attributes.specs.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const stagedSpecs = operation.intent.specifics
        .filter(({ name }) => reservedSpecificKey(name) === null)
        .map(({ name, value }) => `${name}: ${value}`);
      const hadVisibleSpecs = Object.keys(operation.snapshot.specifics).some(
        (name) => reservedSpecificKey(name) === null,
      );
      const corrections = {
        ...parseIdentityCorrections({
          brand: correctedIdentityValue(operation, attributes, "brand"),
          model: correctedIdentityValue(operation, attributes, "model"),
          category: correctedIdentityValue(operation, attributes, "category"),
          condition: operation.intent.condition,
          isbn: correctedIdentityValue(operation, attributes, "isbn"),
          upc: correctedIdentityValue(operation, attributes, "upc"),
          specifications: "",
        }),
        specs:
          stagedSpecs.length > 0 || hadVisibleSpecs ? stagedSpecs : currentSpecs,
      };

      await (dependencies.regenerate ?? regenerateReviewListing)(
        createSupabaseReviewRegenerationStore(supabase, guidedCorrection),
        {
          itemId: operation.snapshot.itemId,
          expectedReviewRevision:
            operation.intent.expectedReviewRevision,
          corrections,
        },
        { randomUUID: () => operation.idempotencyKey },
      );
    },
  };
}

export function createListingReviewSaver(
  dataClient: ListingReviewSaveDataClient,
  regenerator: ListingReviewSaveRegenerator,
): ListingReviewSaver {
  return {
    async save(input) {
      const operation = {
        ...input,
        intent: listingReviewSaveIntentSchema.parse(input.intent),
      };
      const first = await dataClient.execute(operation);
      if (first.state === "completed") return first.receipt;
      if (first.state === "in_progress") {
        throw new ListingReviewSaveInProgressError();
      }
      try {
        await regenerator.regenerate({
          ...operation,
          snapshot: first.snapshot,
        });
        const completed = await dataClient.execute(operation);
        if (completed.state === "completed") return completed.receipt;
        throw new ListingReviewSaveDataError();
      } catch (error) {
        await dataClient.release(operation).catch(() => undefined);
        if (isStaleRegenerationError(error)) {
          throw new ListingReviewStaleError();
        }
        if (isNotEditableRegenerationError(error)) {
          throw new ListingReviewNotEditableError();
        }
        throw error;
      }
    },
  };
}

export function createConfiguredSupabaseListingReviewSaver(input: {
  publishableKey: string;
  supabaseURL: string;
  completionClient: GuidedCorrectionCompletionRpcClient;
}): ListingReviewSaver {
  if (!input.publishableKey.startsWith("sb_publishable_")) {
    throw new Error(
      "Listing Review save requires a current Supabase publishable key.",
    );
  }
  const clientForBearer = (bearerToken: string) =>
    createClient(input.supabaseURL, input.publishableKey, {
      accessToken: async () => bearerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
  return createListingReviewSaver(
    createListingReviewSaveDataClient(clientForBearer),
    createListingReviewSaveRegenerator({
      clientForBearer,
      completionClient: input.completionClient,
    }),
  );
}
