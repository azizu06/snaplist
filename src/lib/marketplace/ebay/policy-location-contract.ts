import { z } from "zod";

export const ebayPolicyLocationCandidateSchema = z
  .object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(80),
    providerDefault: z.boolean(),
  })
  .strict();

export type EbayPolicyLocationCandidate = z.infer<
  typeof ebayPolicyLocationCandidateSchema
>;

export const ebayPolicyLocationCandidatesSchema = z
  .object({
    fulfillmentPolicies: z.array(ebayPolicyLocationCandidateSchema),
    paymentPolicies: z.array(ebayPolicyLocationCandidateSchema),
    returnPolicies: z.array(ebayPolicyLocationCandidateSchema),
    inventoryLocations: z.array(ebayPolicyLocationCandidateSchema),
  })
  .strict();

export type EbayPolicyLocationCandidates = z.infer<
  typeof ebayPolicyLocationCandidatesSchema
>;

const boundChoiceSchema = z
  .object({
    state: z.literal("bound"),
    selectedId: z.string().min(1).max(256),
    candidates: z.array(ebayPolicyLocationCandidateSchema).min(1),
  })
  .strict()
  .superRefine((choice, context) => {
    if (!choice.candidates.some((candidate) => candidate.id === choice.selectedId)) {
      context.addIssue({
        code: "custom",
        message: "The selected eBay candidate must be present in candidates.",
        path: ["selectedId"],
      });
    }
  });

const setupRequiredChoiceSchema = z
  .object({
    state: z.literal("setupRequired"),
    selectedId: z.null(),
    candidates: z.array(ebayPolicyLocationCandidateSchema).length(0),
  })
  .strict();

const selectionRequiredChoiceSchema = z
  .object({
    state: z.literal("selectionRequired"),
    selectedId: z.null(),
    candidates: z.array(ebayPolicyLocationCandidateSchema).min(2),
  })
  .strict();

export const ebayPolicyLocationChoiceSchema = z.union([
  boundChoiceSchema,
  setupRequiredChoiceSchema,
  selectionRequiredChoiceSchema,
]);

export type EbayPolicyLocationChoice = z.infer<
  typeof ebayPolicyLocationChoiceSchema
>;

export const ebayPolicyLocationBindingSchema = z
  .object({
    state: z.enum(["ready", "setupRequired", "selectionRequired"]),
    marketplaceId: z.string().min(1).max(64),
    connectionGeneration: z.string().uuid(),
    fulfillmentPolicy: ebayPolicyLocationChoiceSchema,
    paymentPolicy: ebayPolicyLocationChoiceSchema,
    returnPolicy: ebayPolicyLocationChoiceSchema,
    inventoryLocation: ebayPolicyLocationChoiceSchema,
    discoveredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((binding, context) => {
    const choiceStates = [
      binding.fulfillmentPolicy.state,
      binding.paymentPolicy.state,
      binding.returnPolicy.state,
      binding.inventoryLocation.state,
    ];
    const expectedState = choiceStates.includes("selectionRequired")
      ? "selectionRequired"
      : choiceStates.includes("setupRequired")
        ? "setupRequired"
        : "ready";
    if (binding.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: `The aggregate eBay setup state must be ${expectedState}.`,
        path: ["state"],
      });
    }
  });

export type EbayPolicyLocationBinding = z.infer<
  typeof ebayPolicyLocationBindingSchema
>;
