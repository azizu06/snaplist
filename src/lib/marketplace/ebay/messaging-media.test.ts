import { describe, expect, it, vi } from "vitest";
import { MarketplaceDeliveryError } from "@/lib/marketplace/messaging";
import { HttpEbayMessagingAdapter } from "./messaging";

const tokenProvider = {
  getAccessToken: vi.fn(async () => "seller-token"),
};

const hostedPhoto = {
  providerMediaId: "eps-image-42",
  mediaName: "condition.jpg",
  mediaType: "IMAGE" as const,
  mediaUrl: "https://i.ebayimg.com/images/g/example/s-l1600.jpg",
  expiresAt: "2026-08-13T12:00:00.000Z",
};

describe("eBay message photo mapping", () => {
  it("imports supported buyer image media with the exact question identity", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/commerce/message/v1/conversation")) {
        return Response.json({ conversations: [{
          conversationId: "commerce-conversation-9",
          latestMessage: {
            messageId: "question-parent-42",
            senderUsername: "buyer-7",
            messageBody: "See the photo",
            createdDate: "2026-07-14T11:00:00.000Z",
            messageMedia: [{
              mediaName: "buyer-condition.jpg",
              mediaType: "IMAGE",
              mediaUrl: hostedPhoto.mediaUrl,
            }],
          },
        }] });
      }
      if (String(init?.body).includes("<MessageStatus>Answered</MessageStatus>")) {
        return new Response("<GetMemberMessagesResponse><Ack>Success</Ack><HasMoreItems>false</HasMoreItems></GetMemberMessagesResponse>");
      }
      return new Response(`<GetMemberMessagesResponse><Ack>Success</Ack><MemberMessage><MemberMessageExchange><Item><ItemID>listing-9</ItemID></Item><Question><SenderID>buyer-7</SenderID><Body>See the photo</Body><MessageID>question-parent-42</MessageID><MessageMedia><MediaName>buyer-condition.jpg</MediaName><MediaURL>${hostedPhoto.mediaUrl}</MediaURL></MessageMedia></Question><MessageStatus>Unanswered</MessageStatus><CreationDate>2026-07-14T11:00:00.000Z</CreationDate></MemberMessageExchange></MemberMessage><HasMoreItems>false</HasMoreItems></GetMemberMessagesResponse>`);
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: "https://api.sandbox.ebay.com" }),
    });

    const result = await adapter.fetchUnansweredQuestions({
      from: new Date("2026-07-14T10:00:00.000Z"),
      to: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(result.questions[0]).toEqual(expect.objectContaining({
      externalMessageId: "question-parent-42",
      externalConversationId: "commerce-conversation-9",
      media: [{
        mediaName: "buyer-condition.jpg",
        mediaType: "IMAGE",
        mediaUrl: hostedPhoto.mediaUrl,
      }],
    }));
  });

  it("uploads a supported photo through the current Commerce Media EPS endpoint", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://apim.sandbox.ebay.com/commerce/media/v1_beta/image/create_image_from_file",
      );
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer seller-token",
      );
      const body = init?.body as FormData;
      const image = body.get("image");
      expect(image).toBeInstanceOf(File);
      expect((image as File).name).toBe("condition.jpg");
      return Response.json(
        {
          imageUrl: hostedPhoto.mediaUrl,
          expirationDate: hostedPhoto.expiresAt,
        },
        {
          status: 201,
          headers: {
            location:
              "https://apim.sandbox.ebay.com/commerce/media/v1_beta/image/eps-image-42",
          },
        },
      );
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: "https://api.sandbox.ebay.com" }),
    });

    await expect(
      adapter.uploadPhoto({
        accountGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "condition.jpg",
        mediaType: "image/jpeg",
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        idempotencyKey: "attachment-1",
      }),
    ).resolves.toEqual(hostedPhoto);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the exact Trading reply identity and adds every EPS reference", async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const xml = String(init?.body);
      expect(xml).toContain("<ParentMessageID>exact-question-42</ParentMessageID>");
      expect(xml).toContain("<ItemID>listing-9</ItemID>");
      expect(xml).toContain("<RecipientID>buyer-7</RecipientID>");
      expect(xml).toContain("<MediaName>condition.jpg</MediaName>");
      expect(xml).toContain(`<MediaURL>${hostedPhoto.mediaUrl}</MediaURL>`);
      return new Response(
        `<AddMemberMessageRTQResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><CorrelationID>reply-1</CorrelationID><Timestamp>2026-07-14T12:00:00.000Z</Timestamp></AddMemberMessageRTQResponse>`,
      );
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: "https://api.sandbox.ebay.com" }),
    });

    await adapter.replyToQuestion({
      externalParentId: "exact-question-42",
      externalConversationId: "commerce-conversation-9",
      externalListingId: "listing-9",
      externalBuyerId: "buyer-7",
      body: "Here is the condition photo.",
      idempotencyKey: "reply-1",
      media: [hostedPhoto],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a media-bearing Trading warning visibly ambiguous", async () => {
    const fetchSpy = vi.fn(async () => new Response(
      `<AddMemberMessageRTQResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Warning</Ack><Errors><SeverityCode>Warning</SeverityCode><ShortMessage>One or more media entries were not accepted.</ShortMessage></Errors><CorrelationID>reply-1</CorrelationID></AddMemberMessageRTQResponse>`,
    ));
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: "https://api.sandbox.ebay.com" }),
    });

    const error = await adapter.replyToQuestion({
      externalParentId: "exact-question-42",
      externalConversationId: "commerce-conversation-9",
      externalListingId: "listing-9",
      externalBuyerId: "buyer-7",
      body: "Here is the condition photo.",
      idempotencyKey: "reply-1",
      media: [hostedPhoto],
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MarketplaceDeliveryError);
    expect(error).toMatchObject({ kind: "ambiguous" });
  });

  it("keeps the exact Commerce conversation and maps image-only message media", async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        conversationId: "commerce-conversation-9",
        messageText: "Here is one more angle.",
        messageMedia: [
          {
            mediaName: "condition.jpg",
            mediaType: "IMAGE",
            mediaUrl: hostedPhoto.mediaUrl,
          },
        ],
      });
      return Response.json(
        {
          messageId: "followup-1",
          createdDate: "2026-07-14T12:00:00.000Z",
        },
        { status: 201 },
      );
    });
    const adapter = new HttpEbayMessagingAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: "https://api.sandbox.ebay.com" }),
    });

    await adapter.sendFollowUp({
      externalParentId: "exact-question-42",
      externalConversationId: "commerce-conversation-9",
      externalListingId: "listing-9",
      externalBuyerId: "buyer-7",
      body: "Here is one more angle.",
      idempotencyKey: "followup-request-1",
      media: [hostedPhoto],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
