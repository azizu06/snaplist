import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearApnsTestEnv,
  configureApnsTestEnv,
} from "@/test/apns-test-config";

/**
 * Issue #891. Both publish entry points announce, or neither does.
 *
 * There are two ways into the same publish service: the web route the browser
 * calls and the mobile composition the native client calls. The announcement
 * lives in the shared service, so the only way they can disagree is one of them
 * forgetting to hand it the capability. That is not a hypothetical: it is the
 * exact shape of the divergence AGENTS.md puts the shared service in `src/lib`
 * to prevent, and it fails silently, because a publish with no push still
 * publishes.
 *
 * So this asserts the wiring itself at both roots rather than the behaviour
 * twice. Nothing here reaches Supabase, eBay, or Apple.
 */

const {
  createEbayAdapterForUser,
  createMobileEbayPublishService,
  publishListingToEbayAndNotify,
} = vi.hoisted(() => ({
  createEbayAdapterForUser: vi.fn(async (..._args: unknown[]) => ({
    kind: "adapter",
  })),
  createMobileEbayPublishService: vi.fn((..._args: unknown[]) => ({
    publish: vi.fn(),
  })),
  publishListingToEbayAndNotify: vi.fn(async (..._args: unknown[]) => ({
    ebayStatus: "published",
  })),
}));

vi.mock("@/lib/marketplace/ebay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/marketplace/ebay")>()),
  createEbayAdapterForUser,
  createMobileEbayPublishService,
  publishListingToEbayAndNotify,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: vi.fn() }),
}));
vi.mock("@/lib/supabase/tenant-server", () => ({
  createTenantServerClient: async () => ({ rpc: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ getUserId: async () => "user_seller" }));
vi.mock("@/lib/abuse", () => ({ enforceRateLimit: async () => undefined }));

import { POST } from "@/app/api/ebay/publish/route";
import { handleMobileEbayPublishRequest } from "@/app/v1/mobile-ebay-publish-composition";
import { createInternalPipelineWorkerCapabilities } from "@/lib/pipeline-queue/internal";

beforeAll(() => {
  configureApnsTestEnv();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_wiring";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_wiring";
  process.env.SERVER_RPC_SECRET = "a".repeat(48);
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_wiring";
  process.env.GUEST_RECOVERY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
    "base64",
  );
  process.env.GUEST_RECOVERY_ENCRYPTION_KEY_ID = "wiring-key";
  // The worker root builds the shared admin client, which validates the whole
  // server environment. None of it is reached here.
  process.env.OPENAI_API_KEY = "sk-wiring-test";
});

afterAll(() => {
  clearApnsTestEnv();
  for (const name of [
    "SUPABASE_SECRET_KEY",
    "SERVER_RPC_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GUEST_RECOVERY_ENCRYPTION_KEY",
    "GUEST_RECOVERY_ENCRYPTION_KEY_ID",
    "OPENAI_API_KEY",
  ]) {
    delete process.env[name];
  }
});

beforeEach(() => {
  publishListingToEbayAndNotify.mockClear();
  createMobileEbayPublishService.mockClear();
});

function isDispatcher(value: unknown): boolean {
  const candidate = value as { listingPublished?: unknown; listingReady?: unknown };
  return (
    typeof candidate?.listingPublished === "function"
    && typeof candidate?.listingReady === "function"
  );
}

describe("publish entry points", () => {
  it("hands the web route's publish a dispatcher", async () => {
    const response = await POST(
      new Request("https://snaplist.example/api/ebay/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingId: "listing-1" }),
      }) as never,
    );

    expect(response.status).toBe(200);
    const options = publishListingToEbayAndNotify.mock.calls[0]?.[4];
    expect(isDispatcher((options as { push?: unknown } | undefined)?.push)).toBe(
      true,
    );
  });

  it("hands the mobile composition's publish service a dispatcher", async () => {
    await handleMobileEbayPublishRequest(
      new Request(
        "https://snaplist.example/v1/listings/11111111-1111-4111-8111-111111111111/ebay/publish",
        { method: "POST", headers: { "content-type": "application/json" } },
      ),
    );

    const dependencies = createMobileEbayPublishService.mock.calls[0]?.[0] as
      | { pushFor?: (client: unknown) => unknown }
      | undefined;
    expect(typeof dependencies?.pushFor).toBe("function");
    expect(isDispatcher(dependencies!.pushFor!({ rpc: vi.fn() }))).toBe(true);
  });

  it("hands the pipeline worker a dispatcher for the ready moment", async () => {
    // The third fire point, and the only one with no seller session behind it.
    // If this root forgets, a listing finishes and nobody is told.
    const capabilities = createInternalPipelineWorkerCapabilities();

    expect(isDispatcher(capabilities.push)).toBe(true);
  });
});
