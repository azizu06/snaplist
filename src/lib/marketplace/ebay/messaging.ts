import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type {
  FetchQuestionsInput,
  MarketplaceDeliveryInput,
  MarketplaceDeliveryReceipt,
  MarketplaceMessagingAdapter,
  MarketplaceQuestion,
} from "../messaging";
import { MarketplaceDeliveryError } from "../messaging";
import { EnvTokenProvider } from "./auth";
import type { EbayTokenProvider } from "./types";

const XML_NAMESPACE = "urn:ebay:apis:eBLBaseComponents";
const DEFAULT_COMPATIBILITY_LEVEL = "1455";
const MAX_MESSAGE_BODY = 2_000;
const ENTRIES_PER_PAGE = 200;
const CONVERSATIONS_PER_PAGE = 50;
const MESSAGES_PER_PAGE = 50;
const MESSAGE_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/commerce.message",
];

export interface HttpEbayMessagingAdapterOptions {
  fetch?: typeof fetch;
  tokenProvider?: EbayTokenProvider;
  env?: () => Record<string, string | undefined>;
}

type XmlRecord = Record<string, unknown>;
type ConversationMatchInput = {
  externalMessageId: string;
  externalListingId: string;
  externalBuyerId: string;
  body: string;
  createdAt: string;
  from: Date;
  to: Date;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});
const builder = new XMLBuilder({
  ignoreAttributes: false,
  format: false,
  suppressEmptyNode: true,
});

/**
 * eBay Trading API implementation of the marketplace messaging seam.
 *
 * GetMemberMessages is deliberately used instead of GetMyMessages: only the
 * former returns Question.MessageID, the exact ParentMessageID required by
 * AddMemberMessageRTQ. Request MessageID/CorrelationID is retained only as
 * delivery correlation; eBay does not document it as an idempotency token.
 */
export class HttpEbayMessagingAdapter
  implements MarketplaceMessagingAdapter
{
  private readonly fetchImpl: typeof fetch;
  private readonly tokenProvider: EbayTokenProvider;
  private readonly readEnv: () => Record<string, string | undefined>;

  constructor(options: HttpEbayMessagingAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.readEnv = options.env ?? (() => process.env);
    this.tokenProvider =
      options.tokenProvider ??
      new EnvTokenProvider({
        fetch: options.fetch,
        env: options.env,
        scopes: MESSAGE_SCOPES,
      });
  }

  async fetchUnansweredQuestions(
    input: FetchQuestionsInput,
  ): Promise<MarketplaceQuestion[]> {
    if (input.from.getTime() > input.to.getTime()) {
      throw new Error("Question fetch window starts after it ends");
    }

    const questions: MarketplaceQuestion[] = [];
    let page = 1;
    let hasMore = false;
    do {
      const response = await this.callTrading(
        "GetMemberMessages",
        {
          GetMemberMessagesRequest: {
            "@_xmlns": XML_NAMESPACE,
            MailMessageType: "AskSellerQuestion",
            MessageStatus: "Unanswered",
            StartCreationTime: input.from.toISOString(),
            EndCreationTime: input.to.toISOString(),
            Pagination: {
              EntriesPerPage: ENTRIES_PER_PAGE,
              PageNumber: page,
            },
          },
        },
        false,
      );

      const exchanges = asArray(
        asRecord(response.MemberMessage)?.MemberMessageExchange,
      );
      for (const raw of exchanges) {
        const exchange = asRecord(raw);
        const item = asRecord(exchange?.Item);
        const question = asRecord(exchange?.Question);
        const externalMessageId = asString(question?.MessageID);
        const externalListingId = asString(item?.ItemID);
        const externalBuyerId = asString(question?.SenderID);
        const body = asString(question?.Body);
        const createdAt = asIsoString(exchange?.CreationDate);
        if (
          !externalMessageId ||
          !externalListingId ||
          !externalBuyerId ||
          !body ||
          !createdAt
        ) {
          continue;
        }
        const externalConversationId = await this.resolveConversationId({
          externalMessageId,
          externalListingId,
          externalBuyerId,
          body,
          createdAt,
          from: input.from,
          to: input.to,
        });
        questions.push({
          marketplace: "ebay",
          externalMessageId,
          // Trading's question MessageID is both the imported identity and the
          // root/parent the exact-question reply operation requires.
          externalParentId: externalMessageId,
          externalConversationId,
          externalListingId,
          externalBuyerId,
          body,
          subject: asString(question?.Subject) ?? null,
          createdAt,
        });
      }
      hasMore = response.HasMoreItems === true || response.HasMoreItems === "true";
      page += 1;
    } while (hasMore);

    return questions;
  }

  async replyToQuestion(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt> {
    return this.sendQuestionResponse(input);
  }

  async sendFollowUp(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt> {
    const body = input.body.trim();
    if (body.length === 0 || body.length > MAX_MESSAGE_BODY) {
      throw new MarketplaceDeliveryError(
        "rejected",
        `eBay message body must contain 1-${MAX_MESSAGE_BODY} characters`,
      );
    }

    const env = this.readEnv();
    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const token = await this.tokenProvider.getAccessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${baseUrl.replace(/\/$/, "")}/commerce/message/v1/send_message`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-ebay-c-marketplace-id": env.EBAY_MARKETPLACE_ID ?? "EBAY_US",
          },
          body: JSON.stringify({
            conversationId: input.externalConversationId,
            messageText: body,
          }),
        },
      );
    } catch (cause) {
      throw new MarketplaceDeliveryError(
        "ambiguous",
        "eBay follow-up ended without an acknowledgement",
        { cause },
      );
    }

    const payload = await response.json().catch(() => null) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      throw new MarketplaceDeliveryError(
        response.status >= 500 ? "ambiguous" : "rejected",
        `eBay sendMessage failed (HTTP ${response.status})`,
      );
    }
    const externalDeliveryId = asString(payload?.messageId);
    if (!externalDeliveryId) {
      throw new MarketplaceDeliveryError(
        "ambiguous",
        "eBay follow-up acknowledgement did not include a message id",
      );
    }
    return {
      externalDeliveryId,
      deliveredAt:
        asIsoString(payload?.createdDate) ?? new Date().toISOString(),
    };
  }

  private async resolveConversationId(
    input: ConversationMatchInput,
  ): Promise<string> {
    const env = this.readEnv();
    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const url = new URL(
      `${baseUrl.replace(/\/$/, "")}/commerce/message/v1/conversation`,
    );
    url.searchParams.set("conversation_type", "FROM_MEMBERS");
    url.searchParams.set("conversation_status", "ACTIVE");
    url.searchParams.set("reference_type", "LISTING");
    url.searchParams.set("reference_id", input.externalListingId);
    url.searchParams.set("other_party_username", input.externalBuyerId);
    url.searchParams.set("start_time", input.from.toISOString());
    url.searchParams.set("end_time", input.to.toISOString());
    url.searchParams.set("limit", String(CONVERSATIONS_PER_PAGE));

    const token = await this.tokenProvider.getAccessToken();
    const candidates: XmlRecord[] = [];
    const visited = new Set<string>();
    let pageUrl: URL | null = url;
    while (pageUrl && !visited.has(pageUrl.toString())) {
      visited.add(pageUrl.toString());
      const response = await this.fetchImpl(pageUrl, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-ebay-c-marketplace-id": env.EBAY_MARKETPLACE_ID ?? "EBAY_US",
        },
      });
      const payload = await response.json().catch(() => null) as Record<
        string,
        unknown
      > | null;
      if (!response.ok || !payload) {
        throw new Error(
          `Failed to resolve eBay Message API conversation (HTTP ${response.status})`,
        );
      }
      for (const rawCandidate of asArray(payload.conversations)) {
        const candidate = asRecord(rawCandidate);
        if (!candidate) continue;
        const latest = asRecord(candidate.latestMessage);
        const conversationId = asString(candidate.conversationId);
        if (
          messageMatches(latest, input) ||
          (conversationId &&
            await this.conversationContainsMessage(
              baseUrl,
              token,
              conversationId,
              input,
            ))
        ) {
          candidates.push(candidate);
        }
      }
      const next = asString(payload.next);
      pageUrl = next ? new URL(next, baseUrl) : null;
    }
    const exact = candidates.length === 1 ? asString(candidates[0].conversationId) : null;
    if (!exact) {
      throw new Error(
        "Could not uniquely map the eBay question to its Message API conversation",
      );
    }
    return exact;
  }

  private async conversationContainsMessage(
    baseUrl: string,
    token: string,
    conversationId: string,
    input: ConversationMatchInput,
  ): Promise<boolean> {
    const env = this.readEnv();
    const firstPage = new URL(
      `${baseUrl.replace(/\/$/, "")}/commerce/message/v1/conversation/${encodeURIComponent(conversationId)}`,
    );
    firstPage.searchParams.set("conversation_type", "FROM_MEMBERS");
    firstPage.searchParams.set("limit", String(MESSAGES_PER_PAGE));
    const visited = new Set<string>();
    let pageUrl: URL | null = firstPage;
    while (pageUrl && !visited.has(pageUrl.toString())) {
      visited.add(pageUrl.toString());
      const response = await this.fetchImpl(pageUrl, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-ebay-c-marketplace-id": env.EBAY_MARKETPLACE_ID ?? "EBAY_US",
        },
      });
      const payload = await response.json().catch(() => null) as Record<
        string,
        unknown
      > | null;
      if (!response.ok || !payload) {
        throw new Error(
          `Failed to read eBay Message API conversation (HTTP ${response.status})`,
        );
      }
      if (
        asArray(payload.messages)
          .map(asRecord)
          .some((message) => messageMatches(message, input))
      ) {
        return true;
      }
      const next = asString(payload.next);
      pageUrl = next ? new URL(next, baseUrl) : null;
    }
    return false;
  }

  private async sendQuestionResponse(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt> {
    const body = input.body.trim();
    if (body.length === 0) {
      throw new MarketplaceDeliveryError(
        "rejected",
        "eBay message body must not be empty",
      );
    }
    if (body.length > MAX_MESSAGE_BODY) {
      throw new MarketplaceDeliveryError(
        "rejected",
        `eBay message body exceeds ${MAX_MESSAGE_BODY} characters`,
      );
    }

    const response = await this.callTrading(
      "AddMemberMessageRTQ",
      {
        AddMemberMessageRTQRequest: {
          "@_xmlns": XML_NAMESPACE,
          MessageID: input.idempotencyKey,
          ItemID: input.externalListingId,
          MemberMessage: {
            Body: body,
            DisplayToPublic: false,
            ParentMessageID: input.externalParentId,
            RecipientID: input.externalBuyerId,
          },
        },
      },
      true,
    );

    return {
      externalDeliveryId:
        asString(response.CorrelationID) ?? input.idempotencyKey,
      deliveredAt:
        asIsoString(response.Timestamp) ?? new Date().toISOString(),
    };
  }

  private async callTrading(
    callName: "GetMemberMessages" | "AddMemberMessageRTQ",
    request: XmlRecord,
    isWrite: boolean,
  ): Promise<XmlRecord> {
    const env = this.readEnv();
    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const endpoint = `${baseUrl.replace(/\/$/, "")}/ws/api.dll`;
    const token = await this.tokenProvider.getAccessToken();
    const xml = `<?xml version="1.0" encoding="utf-8"?>${builder.build(request)}`;

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "text/xml",
          "x-ebay-api-call-name": callName,
          "x-ebay-api-compatibility-level":
            env.EBAY_TRADING_API_VERSION ?? DEFAULT_COMPATIBILITY_LEVEL,
          "x-ebay-api-siteid": env.EBAY_SITE_ID ?? "0",
          "x-ebay-api-iaf-token": token,
        },
        body: xml,
      });
    } catch (cause) {
      if (isWrite) {
        throw new MarketplaceDeliveryError(
          "ambiguous",
          "eBay delivery ended without an acknowledgement",
          { cause },
        );
      }
      throw new Error("Failed to fetch eBay member messages", { cause });
    }

    const text = await response.text();
    let parsed: XmlRecord;
    try {
      parsed = asRecord(parser.parse(text)) ?? {};
    } catch (cause) {
      if (isWrite) {
        throw new MarketplaceDeliveryError(
          "ambiguous",
          "eBay delivery returned an unreadable acknowledgement",
          { cause },
        );
      }
      throw new Error("eBay member-message response was not valid XML", {
        cause,
      });
    }

    const rootName = `${callName}Response`;
    const root = asRecord(parsed[rootName]);
    if (!response.ok || !root) {
      if (isWrite) {
        throw new MarketplaceDeliveryError(
          response.status >= 500 ? "ambiguous" : "rejected",
          `eBay ${callName} failed (HTTP ${response.status})`,
        );
      }
      throw new Error(`eBay ${callName} failed (HTTP ${response.status})`);
    }

    const ack = asString(root.Ack);
    if (ack === "Failure") {
      const errors = asArray(root.Errors).map(asRecord).filter(Boolean);
      const systemFailure = errors.some(
        (error) => asString(error?.ErrorClassification) === "SystemError",
      );
      const detail =
        errors
          .map((error) =>
            asString(error?.ShortMessage) ?? asString(error?.LongMessage),
          )
          .find(Boolean) ?? `eBay ${callName} rejected the request`;
      if (isWrite) {
        throw new MarketplaceDeliveryError(
          systemFailure ? "failed" : "rejected",
          detail,
        );
      }
      throw new Error(detail);
    }
    if (ack !== "Success" && ack !== "Warning") {
      if (isWrite) {
        throw new MarketplaceDeliveryError(
          "ambiguous",
          `eBay ${callName} returned no delivery acknowledgement`,
        );
      }
      throw new Error(`eBay ${callName} returned no acknowledgement`);
    }
    return root;
  }
}

function asRecord(value: unknown): XmlRecord | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function asIsoString(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function messageMatches(
  message: XmlRecord | undefined,
  input: ConversationMatchInput,
): boolean {
  if (!message) return false;
  const messageId = asString(message.messageId);
  const sender = asString(message.senderUsername);
  const messageBody = asString(message.messageBody);
  const created = asIsoString(message.createdDate);
  return (
    messageId === input.externalMessageId ||
    (sender === input.externalBuyerId &&
      messageBody === input.body &&
      created === input.createdAt)
  );
}
