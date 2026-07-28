import { z } from "zod";

// A factual claim about an external provider is only as good as the clause it
// rests on, so a citation carries the exact wording relied on and the date it
// was read — provider policy moves, and a bare URL cannot show that it did.
const citationSchema = z
  .object({
    url: z.string().url(),
    clause: z.string().min(1),
    quote: z.string().min(1),
    retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const dispositionSchema = z
  .object({
    treatment: z.enum(["delete", "retain", "provider-owned", "blocked"]),
    owner: z.string().min(1),
    deletionTriggers: z.array(z.string().min(1)).min(1),
    maximumRetention: z.string().min(1),
    executor: z.string().min(1),
    completionProof: z.string().min(1),
    // Present where the disposition rests on published provider authority.
    citations: z.array(citationSchema).min(1).optional(),
    // Present where the disposition rests on an owner's judgement instead of
    // provider evidence. Recorded so a later reviewer can revise the choice
    // without mistaking it for something a provider actually stated.
    ownerDecision: z.string().min(1).optional(),
    blockerId: z.string().min(1).optional(),
  })
  .strict();

// Rows whose correctness depends on an external provider's published policy
// rather than on SnapList's own behaviour. They may not be resolved from
// assumption, so the parser requires cited authority on each of them.
const PROVIDER_OBLIGATION_DATA = [
  "hosted-transcription-provider-copy",
  "ebay-publish-receipts",
  "clerk-identity",
  "apple-revenuecat-references",
] as const;

const releaseRetentionContractSchema = z
  .object({
    contract: z.literal("snaplist.lean-mvp-retention"),
    version: z.literal(1),
    status: z.enum(["release-blocked", "complete"]),
    ownerIssue: z.literal(383),
    data: z.array(
      z
        .object({
          id: z.string().min(1),
          releaseDatum: z.literal(true),
          dispositions: z.tuple([dispositionSchema]),
        })
        .strict(),
    ),
    blockers: z.array(
      z
        .object({
          id: z.string().min(1),
          affectedData: z.array(z.string().min(1)).min(1),
          requiredEvidence: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((contract, context) => {
    const mobileOauthDispositionCount = contract.data.filter(
      ({ id }) => id === "mobile-ebay-oauth-session-state",
    ).length;
    if (mobileOauthDispositionCount !== 1) {
      context.addIssue({
        code: "custom",
        message:
          "The contract must contain exactly one mobile eBay OAuth session/state disposition.",
        path: ["data", "mobile-ebay-oauth-session-state"],
      });
    }
    for (const [id, label] of [
      ["app-attest-challenges", "challenge"],
      ["app-attest-current-keys", "current-key"],
    ] as const) {
      const count = contract.data.filter((datum) => datum.id === id).length;
      if (count !== 1) {
        context.addIssue({
          code: "custom",
          message: `The contract must contain exactly one App Attest ${label} disposition.`,
          path: ["data", id],
        });
      }
    }
    const rawVoice = contract.data.find(
      ({ id }) => id === "private-storage-raw-voice",
    );
    if (
      rawVoice?.dispositions[0].maximumRetention !==
      "24 hours after durable server acceptance"
    ) {
      context.addIssue({
        code: "custom",
        message: "Raw seller voice must never be retained beyond 24 hours.",
        path: ["data", "private-storage-raw-voice", "dispositions", 0, "maximumRetention"],
      });
    }
    if (
      !rawVoice?.dispositions[0].deletionTriggers.includes(
        "first-durable-terminal-transcription-outcome",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Raw seller voice must be deleted after terminal transcription.",
        path: ["data", "private-storage-raw-voice", "dispositions", 0, "deletionTriggers"],
      });
    }
    for (const datum of contract.data) {
      const disposition = datum.dispositions[0];
      if (disposition.treatment !== "blocked") continue;
      const blocker = contract.blockers.find(
        ({ id }) => id === disposition.blockerId,
      );
      if (!blocker?.affectedData.includes(datum.id)) {
        context.addIssue({
          code: "custom",
          message: "A blocked disposition must reference a matching blocker record.",
          path: ["data", datum.id, "dispositions", 0, "blockerId"],
        });
      }
    }
    // `status` is a claim about the rows, so the parser holds it to them. A
    // file cannot report itself complete while an unresolved row survives, and
    // it cannot report itself blocked with nothing left blocking it.
    const blockedData = contract.data.filter(
      ({ dispositions }) => dispositions[0].treatment === "blocked",
    );
    if (contract.status === "complete") {
      for (const datum of blockedData) {
        context.addIssue({
          code: "custom",
          message:
            "A complete contract cannot carry a blocked disposition.",
          path: ["data", datum.id, "dispositions", 0, "treatment"],
        });
      }
      if (contract.blockers.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A complete contract cannot carry an open blocker.",
          path: ["blockers"],
        });
      }
    } else if (blockedData.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "A release-blocked contract must identify the blocked disposition holding it back.",
        path: ["status"],
      });
    }
    for (const id of PROVIDER_OBLIGATION_DATA) {
      const disposition = contract.data.find(
        (datum) => datum.id === id,
      )?.dispositions[0];
      // Absence must fail rather than skip: deleting the row would otherwise be
      // a way to shed the citation requirement without tripping anything.
      if (!disposition) {
        context.addIssue({
          code: "custom",
          message:
            "A provider obligation cannot be dropped from the contract.",
          path: ["data", id],
        });
        continue;
      }
      if (disposition.treatment === "blocked") continue;
      if (!disposition.citations) {
        context.addIssue({
          code: "custom",
          message:
            "A resolved provider obligation must cite the published provider authority it rests on.",
          path: ["data", id, "dispositions", 0, "citations"],
        });
      }
    }
  });

export function parseReleaseRetentionContract(input: unknown) {
  return releaseRetentionContractSchema.parse(input);
}
