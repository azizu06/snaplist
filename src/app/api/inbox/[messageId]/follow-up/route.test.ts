import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  messageMarketplace: "ebay" as "ebay" | "simulated",
  createMessagingTransportForConversation: vi.fn(),
  createTenantServerClient: vi.fn(),
  stageOutboundPhotos: vi.fn(),
  validateFormPhotos: vi.fn(),
  assertSellerFollowUpEligible: vi.fn(),
  sendSellerFollowUp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          marketplace: mocks.messageMarketplace,
        },
      })),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return { from: vi.fn(() => query) };
  }),
}));
vi.mock("@/lib/auth", () => ({ getUserId: vi.fn(async () => "user_a") }));
vi.mock("@/lib/abuse", () => ({ enforceRateLimit: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/tenant-server", () => ({
  createTenantServerClient: mocks.createTenantServerClient,
}));
vi.mock("@/lib/inbox/adapters", () => ({
  createMessagingTransportForConversation: mocks.createMessagingTransportForConversation,
}));
vi.mock("@/lib/inbox/attachment-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inbox/attachment-store")>();
  return {
    ...actual,
    stageOutboundPhotos: mocks.stageOutboundPhotos,
    validateFormPhotos: mocks.validateFormPhotos,
    validateStoredPhotos: vi.fn(),
  };
});
vi.mock("@/lib/inbox/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inbox/transport")>();
  return {
    ...actual,
    assertSellerFollowUpEligible: mocks.assertSellerFollowUpEligible,
    sendSellerFollowUp: mocks.sendSellerFollowUp,
  };
});

import { MessageDeliveryConflictError } from "@/lib/inbox/transport";
import { POST } from "./route";

describe("POST /api/inbox/[messageId]/follow-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.messageMarketplace = "ebay";
    mocks.createTenantServerClient.mockResolvedValue({});
    mocks.createMessagingTransportForConversation.mockResolvedValue({
      repository: {},
      adapter: {},
    });
    const conflict = new MessageDeliveryConflictError(
      "Reply to this question before sending a follow-up",
    );
    mocks.assertSellerFollowUpEligible.mockRejectedValue(conflict);
    mocks.sendSellerFollowUp.mockRejectedValue(conflict);
    mocks.validateFormPhotos.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        file: new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", {
          type: "image/jpeg",
        }),
      },
    ]);
    mocks.stageOutboundPhotos.mockResolvedValue([]);
  });

  it("rejects an ineligible follow-up before photos become durable staged rows", async () => {
    const form = new FormData();
    form.set("message", "One more detail");
    form.set("requestId", "33333333-3333-4333-8333-333333333333");

    const response = await POST(
      new Request("http://localhost/api/inbox/message/follow-up", {
        method: "POST",
        body: form,
      }),
      {
        params: Promise.resolve({
          messageId: "11111111-1111-4111-8111-111111111111",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(mocks.stageOutboundPhotos).not.toHaveBeenCalled();
    expect(mocks.sendSellerFollowUp).not.toHaveBeenCalled();
  });

  it("keeps a text-only simulated follow-up independent of attachment infrastructure", async () => {
    mocks.messageMarketplace = "simulated";
    mocks.validateFormPhotos.mockResolvedValue([]);
    mocks.assertSellerFollowUpEligible.mockResolvedValue(undefined);
    mocks.sendSellerFollowUp.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      delivery_status: "delivered",
    });
    const form = new FormData();
    form.set("message", "One more detail");
    form.set("requestId", "33333333-3333-4333-8333-333333333333");

    const response = await POST(
      new Request("http://localhost/api/inbox/message/follow-up", {
        method: "POST",
        body: form,
      }),
      {
        params: Promise.resolve({
          messageId: "11111111-1111-4111-8111-111111111111",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.createTenantServerClient).not.toHaveBeenCalled();
    expect(mocks.stageOutboundPhotos).not.toHaveBeenCalled();
    expect(mocks.sendSellerFollowUp).toHaveBeenCalledWith(expect.objectContaining({
      expectedPhotoIds: [],
    }));
  });

  it("still binds an empty approved photo set for an eBay follow-up", async () => {
    mocks.validateFormPhotos.mockResolvedValue([]);
    mocks.assertSellerFollowUpEligible.mockResolvedValue(undefined);
    mocks.sendSellerFollowUp.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      delivery_status: "delivered",
    });
    const form = new FormData();
    form.set("message", "One more detail");
    form.set("requestId", "33333333-3333-4333-8333-333333333333");

    const response = await POST(
      new Request("http://localhost/api/inbox/message/follow-up", {
        method: "POST",
        body: form,
      }),
      {
        params: Promise.resolve({
          messageId: "11111111-1111-4111-8111-111111111111",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.createTenantServerClient).toHaveBeenCalledOnce();
    expect(mocks.stageOutboundPhotos).toHaveBeenCalledWith(expect.objectContaining({
      photos: [],
    }));
  });
});
