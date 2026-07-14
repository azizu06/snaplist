import type { DraftCandidate } from "./sync";
import {
  draftBuyerReply,
  type DraftBuyerReplyResult,
} from "./reply";
import type { MessageRow } from "./types";
import {
  decideMessagePolicy,
  MESSAGE_POLICY_VERSION,
  type AuthoritativeMessageGrounding,
  type MessagePolicyAuditRecord,
  type MessagePolicyResult,
} from "./policy";

export interface MessagePolicyRepository {
  getEnabled(): Promise<boolean>;
  loadGrounding(message: MessageRow): Promise<AuthoritativeMessageGrounding>;
  recordDecision(
    message: MessageRow,
    result: MessagePolicyResult,
    draft: DraftBuyerReplyResult,
  ): Promise<{ inserted: boolean; decision: MessagePolicyAuditRecord }>;
  listPendingAutoSend(
    policyVersion: string,
  ): Promise<Array<{ messageId: string }>>;
  revalidatePendingAutoSend(
    messageId: string,
  ): Promise<{ marketplaceObservedAt: string } | null>;
}

export async function processMessagePolicyCandidate(input: {
  repository: MessagePolicyRepository;
  candidate: DraftCandidate;
  draft?: typeof draftBuyerReply;
  meterDraft?: () => Promise<void>;
}): Promise<{ inserted: boolean; decision: MessagePolicyAuditRecord }> {
  const [enabled, grounding] = await Promise.all([
    input.repository.getEnabled(),
    input.repository.loadGrounding(input.candidate.message),
  ]);
  const policy = decideMessagePolicy({
    enabled,
    question: input.candidate.message.body,
    grounding,
  });

  let draft: DraftBuyerReplyResult;
  if (policy.outcome === "auto_send" && policy.proposedReply) {
    draft = {
      reply: policy.proposedReply,
      model: `policy:${policy.policyVersion}`,
      usedFallback: false,
    };
  } else {
    await (input.meterDraft ?? (async () => undefined))();
    draft = await (input.draft ?? draftBuyerReply)({
      question: input.candidate.message.body,
      grounding: input.candidate.grounding,
    });
  }

  return input.repository.recordDecision(input.candidate.message, policy, draft);
}

export async function sendPendingAutomaticReplies(input: {
  repository: MessagePolicyRepository;
  send: (
    messageId: string,
    authorization: { marketplaceObservedAt: string },
  ) => Promise<unknown>;
}): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const candidate of await input.repository.listPendingAutoSend(
    MESSAGE_POLICY_VERSION,
  )) {
    try {
      const authorization = await input.repository.revalidatePendingAutoSend(
        candidate.messageId,
      );
      if (!authorization) continue;
      await input.send(candidate.messageId, authorization);
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}
