import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  cleanupOwnExpiredMessagePhotoUploads,
  createClient,
  createTenantServerClient,
  getEbayConnectionStatus,
  logServerError,
} = vi.hoisted(() => ({
  cleanupOwnExpiredMessagePhotoUploads: vi.fn(),
  createClient: vi.fn(async () => ({ role: "tenant" })),
  createTenantServerClient: vi.fn(async () => ({ role: "tenant-server" })),
  getEbayConnectionStatus: vi.fn(async () => ({ connected: false })),
  logServerError: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getUserId: vi.fn(async () => "user_a") }));
vi.mock("@/lib/abuse", () => ({ enforceRateLimit: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/tenant-server", () => ({
  createTenantServerClient,
}));
vi.mock("@/lib/inbox/attachment-cleanup", () => ({
  cleanupOwnExpiredMessagePhotoUploads,
}));
vi.mock("@/lib/inbox/sync", () => ({
  syncInboxForSeller: vi.fn(),
  SupabaseInboxSyncRepository: vi.fn(),
}));
vi.mock("@/lib/marketplace/ebay", () => ({
  getEbayConnectionStatus,
  hasEbayMessagingSandboxFallback: vi.fn(() => false),
  createEbayMessagingAdapterForUser: vi.fn(),
}));
vi.mock("@/lib/api/errors", () => ({
  logServerError,
  serverErrorJson: vi.fn(),
}));

import { POST } from "./route";

describe("foreground inbox maintenance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("expires abandoned photo uploads without requiring the cron deployment", async () => {
    const response = await POST(new Request("https://snaplist.test/api/inbox/sync", {
      method: "POST",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ skipped: "ebay_not_connected" });
    expect(cleanupOwnExpiredMessagePhotoUploads).toHaveBeenCalledWith({
      role: "tenant-server",
    });
    expect(createTenantServerClient).toHaveBeenCalledOnce();
  });
});
