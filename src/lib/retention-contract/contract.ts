import { z } from "zod";

const dispositionSchema = z
  .object({
    treatment: z.enum(["delete", "retain", "provider-owned", "blocked"]),
    owner: z.string().min(1),
    deletionTriggers: z.array(z.string().min(1)).min(1),
    maximumRetention: z.string().min(1),
    executor: z.string().min(1),
    completionProof: z.string().min(1),
    blockerId: z.string().min(1).optional(),
  })
  .strict();

const releaseRetentionContractSchema = z
  .object({
    contract: z.literal("snaplist.lean-mvp-retention"),
    version: z.literal(1),
    status: z.literal("release-blocked"),
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
  });

export function parseReleaseRetentionContract(input: unknown) {
  return releaseRetentionContractSchema.parse(input);
}
