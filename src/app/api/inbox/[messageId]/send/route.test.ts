import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMessagingTransportForConversation: vi.fn(),
  createTenantServerClient: vi.fn(),
  stageOutboundPhotos: vi.fn(),
  validateFormPhotos: vi.fn(),
  sendCanonicalReply: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          marketplace: "ebay",
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
  createMessagingTransportForConversation:
    mocks.createMessagingTransportForConversation,
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
    sendCanonicalReply: mocks.sendCanonicalReply,
  };
});
vi.mock("@/lib/api/errors", () => ({
  serverErrorJson: vi.fn((_scope, _error, message: string) =>
    Response.json({ error: message }, { status: 500 }),
  ),
}));

import { POST } from "./route";

describe("POST /api/inbox/[messageId]/send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessagingTransportForConversation.mockRejectedValue(
      new Error("eBay account is disconnected"),
    );
    mocks.createTenantServerClient.mockResolvedValue({});
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

  it("proves the marketplace transport before photos become durable staged rows", async () => {
    const form = new FormData();
    form.set("reply", "Yes, it includes the charger.");

    const response = await POST(
      new Request("http://localhost/api/inbox/message/send", {
        method: "POST",
        body: form,
      }),
      {
        params: Promise.resolve({
          messageId: "11111111-1111-4111-8111-111111111111",
        }),
      },
    );

    expect(response.status).toBe(500);
    expect(mocks.createMessagingTransportForConversation).toHaveBeenCalledOnce();
    expect(mocks.createTenantServerClient).not.toHaveBeenCalled();
    expect(mocks.stageOutboundPhotos).not.toHaveBeenCalled();
    expect(mocks.sendCanonicalReply).not.toHaveBeenCalled();
  });
});
