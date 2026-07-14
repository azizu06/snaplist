import { describe, expect, it, vi } from "vitest";
import { MarketplaceDeliveryError } from "../messaging";
import { HttpEbayMessagingAdapter } from "./messaging";

const BASE = "https://api.sandbox.ebay.com";

const tokenProvider = { getAccessToken: vi.fn(async () => "seller-token") };

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/xml" },
  });
}

describe("HttpEbayMessagingAdapter", () => {
  it("imports unanswered active-listing questions with exact Trading message identity", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/commerce/message/v1/conversation")) {
        expect(String(url)).toContain("reference_id=110011001100");
        expect(String(url)).toContain("conversation_type=FROM_MEMBERS");
        expect(String(url)).toContain("other_party_username=buyer-public-id");
        return Response.json({
          conversations: [
            {
              conversationId: "commerce-conversation-9",
              referenceId: "110011001100",
              latestMessage: {
                messageId: "question-parent-42",
                senderUsername: "buyer-public-id",
                messageBody: "Does it include the charger?",
                createdDate: "2026-07-13T14:03:00.000Z",
              },
            },
          ],
        });
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-ebay-api-call-name"]).toBe("GetMemberMessages");
      expect(headers["x-ebay-api-iaf-token"]).toBe("seller-token");
      expect(String(init?.body)).toContain("<MailMessageType>AskSellerQuestion</MailMessageType>");
      expect(String(init?.body)).toContain("<MessageStatus>Unanswered</MessageStatus>");
      return xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>110011001100</ItemID></Item>
            <Question>
              <SenderID>buyer-public-id</SenderID>
              <Subject>Question about item</Subject>
              <Body>Does it include the charger?</Body>
              <MessageID>question-parent-42</MessageID>
            </Question>
            <MessageStatus>Unanswered</MessageStatus>
            <CreationDate>2026-07-13T14:03:00.000Z</CreationDate>
          </MemberMessageExchange></MemberMessage>
          <HasMoreItems>false</HasMoreItems>
        </GetMemberMessagesResponse>`);
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    await expect(
      adapter.fetchUnansweredQuestions({
        from: new Date("2026-07-13T14:00:00.000Z"),
        to: new Date("2026-07-13T14:05:00.000Z"),
      }),
    ).resolves.toEqual([
      {
        marketplace: "ebay",
        externalMessageId: "question-parent-42",
        externalParentId: "question-parent-42",
        externalConversationId: "commerce-conversation-9",
        externalListingId: "110011001100",
        externalBuyerId: "buyer-public-id",
        body: "Does it include the charger?",
        subject: "Question about item",
        createdAt: "2026-07-13T14:03:00.000Z",
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses the exact question MessageID as ParentMessageID for replies", async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain(
        "<ParentMessageID>question-parent-42</ParentMessageID>",
      );
      expect(String(init?.body)).toContain("<ItemID>110011001100</ItemID>");
      expect(String(init?.body)).toContain("<RecipientID>buyer-public-id</RecipientID>");
      expect(String(init?.body)).toContain("<DisplayToPublic>false</DisplayToPublic>");
      return xmlResponse(`
        <AddMemberMessageRTQResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <CorrelationID>local-message-1</CorrelationID>
          <Timestamp>2026-07-13T14:04:00.000Z</Timestamp>
        </AddMemberMessageRTQResponse>`);
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    await expect(
      adapter.replyToQuestion({
        externalParentId: "question-parent-42",
        externalConversationId: "question-parent-42",
        externalListingId: "110011001100",
        externalBuyerId: "buyer-public-id",
        body: "Yes, the original charger is included.",
        idempotencyKey: "local-message-1",
      }),
    ).resolves.toEqual({
      externalDeliveryId: "local-message-1",
      deliveredAt: "2026-07-13T14:04:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses Commerce sendMessage with the preserved conversation id for text follow-ups", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://api.sandbox.ebay.com/commerce/message/v1/send_message",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer seller-token");
      expect(JSON.parse(String(init?.body))).toEqual({
        conversationId: "commerce-conversation-9",
        messageText: "I also found the carrying case.",
      });
      return Response.json(
        {
          messageId: "commerce-followup-77",
          conversationId: "commerce-conversation-9",
          createdDate: "2026-07-13T14:08:00.000Z",
        },
        { status: 201 },
      );
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    const result = await adapter.sendFollowUp({
      externalParentId: "question-parent-42",
      externalConversationId: "commerce-conversation-9",
      externalListingId: "110011001100",
      externalBuyerId: "buyer-public-id",
      body: "I also found the carrying case.",
      idempotencyKey: "followup-local-7",
    });
    expect(result).toEqual({
      externalDeliveryId: "commerce-followup-77",
      deliveredAt: "2026-07-13T14:08:00.000Z",
    });
  });

  it("classifies an HTTP/network write without an acknowledgement as ambiguous", async () => {
    const adapter = new HttpEbayMessagingAdapter({
      fetch: vi.fn(async () => {
        throw new TypeError("socket closed");
      }) as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });
    const err = await adapter
      .replyToQuestion({
        externalParentId: "parent",
        externalConversationId: "parent",
        externalListingId: "listing",
        externalBuyerId: "buyer",
        body: "Reply",
        idempotencyKey: "key",
      })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(MarketplaceDeliveryError);
    expect((err as MarketplaceDeliveryError).kind).toBe("ambiguous");
  });

  it("treats a Trading RequestError as a definitive rejection", async () => {
    const adapter = new HttpEbayMessagingAdapter({
      fetch: vi.fn(async () =>
        xmlResponse(`
          <AddMemberMessageRTQResponse xmlns="urn:ebay:apis:eBLBaseComponents">
            <Ack>Failure</Ack><Errors><ErrorClassification>RequestError</ErrorClassification>
            <ShortMessage>Invalid parent message.</ShortMessage></Errors>
          </AddMemberMessageRTQResponse>`),
      ) as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });
    const err = await adapter
      .replyToQuestion({
        externalParentId: "wrong-parent",
        externalConversationId: "wrong-parent",
        externalListingId: "listing",
        externalBuyerId: "buyer",
        body: "Reply",
        idempotencyKey: "key",
      })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(MarketplaceDeliveryError);
    expect((err as MarketplaceDeliveryError).kind).toBe("rejected");
  });
});
