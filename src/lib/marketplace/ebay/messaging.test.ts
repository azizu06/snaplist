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
        const parsed = new URL(String(url));
        expect(parsed.searchParams.get("reference_id")).toBe("110011001100");
        expect(parsed.searchParams.get("conversation_type")).toBe("FROM_MEMBERS");
        expect(parsed.searchParams.get("conversation_status")).toBe("ACTIVE");
        expect(parsed.searchParams.has("conversationStatus")).toBe(false);
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
      expect(String(init?.body)).not.toContain("<MessageStatus>");
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
    ).resolves.toEqual({
      questions: [
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
      ],
      unresolved: [],
      answeredExternalMessageIds: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("resolves by listing and exact message identity without a buyer username filter", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("/commerce/message/v1/conversation")) {
        const parsed = new URL(String(url));
        expect(parsed.searchParams.get("reference_id")).toBe(
          "listing-public-id",
        );
        expect(parsed.searchParams.has("other_party_username")).toBe(false);
        return Response.json({
          conversations: [
            {
              conversationId: "conversation-public-id",
              latestMessage: {
                messageId: "question-public-id",
                senderUsername: "legacy-buyer-username",
                messageBody: "Is the box included?",
                createdDate: "2026-07-13T14:03:00.000Z",
              },
            },
          ],
        });
      }
      return xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>listing-public-id</ItemID></Item>
            <Question><SenderID>immutable-public-user-id</SenderID><Body>Is the box included?</Body><MessageID>question-public-id</MessageID></Question>
            <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-13T14:03:00.000Z</CreationDate>
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
    ).resolves.toMatchObject({
      questions: [
        {
          externalMessageId: "question-public-id",
          externalConversationId: "conversation-public-id",
          externalBuyerId: "immutable-public-user-id",
        },
      ],
      unresolved: [],
      answeredExternalMessageIds: [],
    });
  });

  it("returns explicit answered evidence without resolving a Commerce conversation", async () => {
    const fetchSpy = vi.fn(async () =>
      xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>listing-answered</ItemID></Item>
            <Question><MessageID>question-answered</MessageID></Question>
            <MessageStatus>Answered</MessageStatus>
            <CreationDate>2026-07-13T14:03:00.000Z</CreationDate>
          </MemberMessageExchange></MemberMessage>
          <HasMoreItems>false</HasMoreItems>
        </GetMemberMessagesResponse>`),
    );
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
    ).resolves.toEqual({
      questions: [],
      unresolved: [],
      answeredExternalMessageIds: ["question-answered"],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("imports every exchange when Trading returns multiple questions", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("/commerce/message/v1/conversation")) {
        const parsed = new URL(String(url));
        const listingId = parsed.searchParams.get("reference_id");
        const suffix = listingId === "listing-a" ? "a" : "b";
        return Response.json({
          conversations: [
            {
              conversationId: `conversation-${suffix}`,
              latestMessage: {
                messageId: `question-${suffix}`,
                senderUsername: `buyer-${suffix}`,
                messageBody: `Question ${suffix}`,
                createdDate: `2026-07-13T14:0${suffix === "a" ? "1" : "2"}:00.000Z`,
              },
            },
          ],
        });
      }
      return xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage>
            <MemberMessageExchange>
              <Item><ItemID>listing-a</ItemID></Item>
              <Question><SenderID>buyer-a</SenderID><Body>Question a</Body><MessageID>question-a</MessageID></Question>
              <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-13T14:01:00.000Z</CreationDate>
            </MemberMessageExchange>
            <MemberMessageExchange>
              <Item><ItemID>listing-b</ItemID></Item>
              <Question><SenderID>buyer-b</SenderID><Body>Question b</Body><MessageID>question-b</MessageID></Question>
              <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-13T14:02:00.000Z</CreationDate>
            </MemberMessageExchange>
          </MemberMessage>
          <HasMoreItems>false</HasMoreItems>
        </GetMemberMessagesResponse>`);
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    const result = await adapter.fetchUnansweredQuestions({
      from: new Date("2026-07-13T14:00:00.000Z"),
      to: new Date("2026-07-13T14:05:00.000Z"),
    });

    expect(result.questions.map((question) => question.externalMessageId)).toEqual([
      "question-a",
      "question-b",
    ]);
  });

  it("returns unresolved Trading identities beside resolvable questions", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("/commerce/message/v1/conversation")) {
        const listingId = new URL(String(url)).searchParams.get("reference_id");
        if (listingId === "listing-unresolved") {
          return Response.json({ error: "temporarily unavailable" }, { status: 503 });
        }
        return Response.json({
          conversations: [
            {
              conversationId: "conversation-valid",
              latestMessage: {
                messageId: "question-valid",
                senderUsername: "buyer-valid",
                messageBody: "Does it power on?",
                createdDate: "2026-07-13T14:02:00.000Z",
              },
            },
          ],
        });
      }
      return xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage>
            <MemberMessageExchange>
              <Item><ItemID>listing-unresolved</ItemID></Item>
              <Question><SenderID>buyer-unresolved</SenderID><Body>Is this complete?</Body><MessageID>question-unresolved</MessageID></Question>
              <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-13T14:01:00.000Z</CreationDate>
            </MemberMessageExchange>
            <MemberMessageExchange>
              <Item><ItemID>listing-valid</ItemID></Item>
              <Question><SenderID>buyer-valid</SenderID><Body>Does it power on?</Body><MessageID>question-valid</MessageID></Question>
              <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-13T14:02:00.000Z</CreationDate>
            </MemberMessageExchange>
          </MemberMessage>
          <HasMoreItems>false</HasMoreItems>
        </GetMemberMessagesResponse>`);
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    const result = await adapter.fetchUnansweredQuestions({
      from: new Date("2026-07-12T14:05:00.000Z"),
      to: new Date("2026-07-13T14:05:00.000Z"),
    });

    expect(result).toMatchObject({
      questions: [
        {
          externalMessageId: "question-valid",
          externalConversationId: "conversation-valid",
        },
      ],
      unresolved: [
        {
          question: {
            externalMessageId: "question-unresolved",
            externalParentId: "question-unresolved",
            externalListingId: "listing-unresolved",
            externalBuyerId: "buyer-unresolved",
            body: "Is this complete?",
            subject: null,
            createdAt: "2026-07-13T14:01:00.000Z",
            resolutionWindowFrom: "2026-07-12T14:05:00.000Z",
            observedCursorAt: "2026-07-13T14:05:00.000Z",
          },
          error: "Failed to resolve eBay Message API conversation (HTTP 503)",
        },
      ],
    });
  });

  it("preserves a stable malformed Trading identity for later resolution", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("/commerce/message/v1/conversation")) {
        return Response.json({ error: "temporarily unavailable" }, { status: 503 });
      }
      return xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>listing-partial</ItemID></Item>
            <Question><MessageID>question-partial</MessageID></Question>
            <MessageStatus>Unanswered</MessageStatus>
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
    ).resolves.toMatchObject({
      questions: [],
      unresolved: [
        {
          question: {
            externalMessageId: "question-partial",
            externalParentId: "question-partial",
            externalListingId: "listing-partial",
            externalBuyerId: null,
            body: null,
            createdAt: null,
          },
          error: "Failed to resolve eBay Message API conversation (HTTP 503)",
        },
      ],
    });
  });

  it("recovers missing Trading details from the exact Commerce message", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("/commerce/message/v1/conversation")) {
        return Response.json({
          conversations: [
            {
              conversationId: "conversation-partial",
              latestMessage: {
                messageId: "question-partial",
                senderUsername: "buyer-partial",
                messageBody: "Is the charger included?",
                createdDate: "2026-07-13T14:03:00.000Z",
              },
            },
          ],
        });
      }
      return xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>listing-partial</ItemID></Item>
            <Question><MessageID>question-partial</MessageID></Question>
            <MessageStatus>Unanswered</MessageStatus>
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
    ).resolves.toMatchObject({
      questions: [
        {
          externalMessageId: "question-partial",
          externalConversationId: "conversation-partial",
          externalListingId: "listing-partial",
          externalBuyerId: "buyer-partial",
          body: "Is the charger included?",
          createdAt: "2026-07-13T14:03:00.000Z",
        },
      ],
      unresolved: [],
    });
  });

  it("fails the fetch when a Trading exchange lacks stable identity", async () => {
    const fetchSpy = vi.fn(async () =>
      xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>listing-without-message-id</ItemID></Item>
            <Question><SenderID>buyer-a</SenderID><Body>Is this complete?</Body></Question>
            <MessageStatus>Unanswered</MessageStatus>
            <CreationDate>2026-07-13T14:01:00.000Z</CreationDate>
          </MemberMessageExchange></MemberMessage>
          <HasMoreItems>false</HasMoreItems>
        </GetMemberMessagesResponse>`),
    );
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
    ).rejects.toThrow("stable identity");
  });

  it("preserves digit-only provider identifiers as exact strings", async () => {
    const listingId = "000123";
    const questionId = "000987";
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("/commerce/message/v1/conversation")) {
        expect(new URL(String(url)).searchParams.get("reference_id")).toBe(listingId);
        return Response.json({
          conversations: [
            {
              conversationId: "conversation-long-id",
              latestMessage: {
                messageId: questionId,
                senderUsername: "buyer-long-id",
                messageBody: "Is this still available?",
                createdDate: "2026-07-13T14:03:00.000Z",
              },
            },
          ],
        });
      }
      return xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>${listingId}</ItemID></Item>
            <Question><SenderID>buyer-long-id</SenderID><Body>Is this still available?</Body><MessageID>${questionId}</MessageID></Question>
            <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-13T14:03:00.000Z</CreationDate>
          </MemberMessageExchange></MemberMessage>
          <HasMoreItems>false</HasMoreItems>
        </GetMemberMessagesResponse>`);
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    const result = await adapter.fetchUnansweredQuestions({
      from: new Date("2026-07-13T14:00:00.000Z"),
      to: new Date("2026-07-13T14:05:00.000Z"),
    });

    expect(result.questions[0]).toMatchObject({
      externalMessageId: questionId,
      externalParentId: questionId,
      externalListingId: listingId,
    });
  });

  it("resolves an older unanswered question from the full Commerce conversation", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const text = String(url);
      const parsed = new URL(text);
      if (parsed.pathname.endsWith("/conversation/conversation-shared")) {
        expect(parsed.searchParams.get("conversation_type")).toBe("FROM_MEMBERS");
        if (parsed.searchParams.get("offset") === "50") {
          return Response.json({
            messages: [
              {
                messageId: "question-older",
                senderUsername: "buyer-shared",
                messageBody: "Is the manual included?",
                createdDate: "2026-07-13T14:01:00.000Z",
              },
            ],
          });
        }
        return Response.json({
          conversationId: "conversation-shared",
          messages: [
            {
              messageId: "question-latest",
              senderUsername: "buyer-shared",
              messageBody: "Any scratches?",
              createdDate: "2026-07-13T14:02:00.000Z",
            },
          ],
          next:
            "/commerce/message/v1/conversation/conversation-shared?conversation_type=FROM_MEMBERS&limit=50&offset=50",
        });
      }
      if (text.includes("/commerce/message/v1/conversation")) {
        return Response.json({
          conversations: [
            {
              conversationId: "conversation-shared",
              latestMessage: {
                messageId: "question-latest",
                senderUsername: "buyer-shared",
                messageBody: "Any scratches?",
                createdDate: "2026-07-13T14:02:00.000Z",
              },
            },
          ],
        });
      }
      return xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>listing-shared</ItemID></Item>
            <Question><SenderID>buyer-shared</SenderID><Body>Is the manual included?</Body><MessageID>question-older</MessageID></Question>
            <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-13T14:01:00.000Z</CreationDate>
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
    ).resolves.toMatchObject({
      questions: [
        {
          externalMessageId: "question-older",
          externalConversationId: "conversation-shared",
        },
      ],
      unresolved: [],
      answeredExternalMessageIds: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("paginates Commerce conversation candidates ten at a time", async () => {
    const conversationUrls: URL[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/commerce/message/v1/conversation")) {
        conversationUrls.push(parsed);
        if (parsed.searchParams.get("offset") === "10") {
          return Response.json({
            conversations: [
              {
                conversationId: "conversation-second-page",
                latestMessage: {
                  messageId: "question-second-page",
                  senderUsername: "buyer-second-page",
                  messageBody: "Can you combine shipping?",
                  createdDate: "2026-07-13T14:03:00.000Z",
                },
              },
            ],
          });
        }
        return Response.json({
          conversations: [],
          next: "/commerce/message/v1/conversation?limit=10&offset=10",
        });
      }
      return xmlResponse(`
        <GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <MemberMessage><MemberMessageExchange>
            <Item><ItemID>listing-second-page</ItemID></Item>
            <Question><SenderID>buyer-second-page</SenderID><Body>Can you combine shipping?</Body><MessageID>question-second-page</MessageID></Question>
            <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-13T14:03:00.000Z</CreationDate>
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
    ).resolves.toMatchObject({
      questions: [
        {
          externalMessageId: "question-second-page",
          externalConversationId: "conversation-second-page",
        },
      ],
      unresolved: [],
      answeredExternalMessageIds: [],
    });
    expect(conversationUrls).toHaveLength(2);
    expect(conversationUrls[0].searchParams.get("limit")).toBe("10");
    expect(conversationUrls[1].searchParams.get("offset")).toBe("10");
  });

  it("rejects cross-origin conversation pagination before reusing the seller token", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({ conversations: [], next: "https://attacker.example/steal" }),
    );
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    await expect(
      adapter.resolveQuestion({
        marketplace: "ebay",
        externalMessageId: "question-hostile-next",
        externalParentId: "question-hostile-next",
        externalListingId: "listing-hostile-next",
        externalBuyerId: "buyer-hostile-next",
        body: "Is this available?",
        subject: null,
        createdAt: "2026-07-13T14:03:00.000Z",
        resolutionWindowFrom: "2026-07-12T14:05:00.000Z",
        observedCursorAt: "2026-07-13T14:05:00.000Z",
      }),
    ).rejects.toThrow("Unsafe eBay pagination URL");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin message pagination before reusing the seller token", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/conversation/conversation-hostile-next")) {
        return Response.json({
          messages: [],
          next: "https://attacker.example/steal",
        });
      }
      return Response.json({
        conversations: [
          {
            conversationId: "conversation-hostile-next",
            latestMessage: {
              messageId: "another-question",
              messageBody: "Another question",
              createdDate: "2026-07-13T14:04:00.000Z",
            },
          },
        ],
      });
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    await expect(
      adapter.resolveQuestion({
        marketplace: "ebay",
        externalMessageId: "question-hostile-next",
        externalParentId: "question-hostile-next",
        externalListingId: "listing-hostile-next",
        externalBuyerId: "buyer-hostile-next",
        body: "Is this available?",
        subject: null,
        createdAt: "2026-07-13T14:03:00.000Z",
        resolutionWindowFrom: "2026-07-12T14:05:00.000Z",
        observedCursorAt: "2026-07-13T14:05:00.000Z",
      }),
    ).rejects.toThrow("Unsafe eBay pagination URL");
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
        accountGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
    expect(tokenProvider.getAccessToken).toHaveBeenLastCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
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
      accountGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
    expect(tokenProvider.getAccessToken).toHaveBeenLastCalledWith(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
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

  it("classifies a Trading acknowledgement read failure as ambiguous", async () => {
    const response = {
      ok: true,
      status: 200,
      text: vi.fn(async () => {
        throw new TypeError("response stream closed");
      }),
    } as unknown as Response;
    const adapter = new HttpEbayMessagingAdapter({
      fetch: vi.fn(async () => response) as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    const error = await adapter
      .replyToQuestion({
        externalParentId: "parent",
        externalConversationId: "conversation",
        externalListingId: "listing",
        externalBuyerId: "buyer",
        body: "Reply",
        idempotencyKey: "key",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MarketplaceDeliveryError);
    expect((error as MarketplaceDeliveryError).kind).toBe("ambiguous");
  });

  it("classifies a successful Trading response without its acknowledgement root as ambiguous", async () => {
    const adapter = new HttpEbayMessagingAdapter({
      fetch: vi.fn(async () =>
        xmlResponse(`
          <UnexpectedResponse xmlns="urn:ebay:apis:eBLBaseComponents">
            <Ack>Success</Ack>
          </UnexpectedResponse>`),
      ) as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    const error = await adapter
      .replyToQuestion({
        externalParentId: "parent",
        externalConversationId: "conversation",
        externalListingId: "listing",
        externalBuyerId: "buyer",
        body: "Reply",
        idempotencyKey: "key",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MarketplaceDeliveryError);
    expect((error as MarketplaceDeliveryError).kind).toBe("ambiguous");
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
