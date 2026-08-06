import { afterEach, describe, expect, it, vi } from "vitest";

const serveEbayPhoto = vi.hoisted(() => vi.fn());
const logServerError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/marketplace/ebay/photo-access", () => ({ serveEbayPhoto }));
vi.mock("@/lib/api/errors", () => ({ logServerError }));

import { GET } from "./route";

/**
 * Offline contract for the unauthenticated photo route's failure boundary. The
 * RLS suite in `route.rls.test.ts` proves the happy path against real Storage;
 * this file proves what the caller sees when the read fails, which no live
 * stack can be made to do on demand.
 */
function request(token = "A".repeat(43)) {
  return GET(new Request(`https://snaplist.dev/m/${token}`), {
    params: Promise.resolve({ token }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function configured() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
}

describe("GET /m/[token] failure boundary", () => {
  it("reports a rejected photo read and answers 503 rather than a framework 500", async () => {
    // The rejection has to be observed INSIDE the try. Returning the promise
    // unawaited resolved the try block first, so this whole branch — the
    // report, the 503, the no-store header — was unreachable in production.
    configured();
    serveEbayPhoto.mockRejectedValue(
      new Error("Failed to download eBay photo: Storage is unavailable"),
    );

    const response = await request();

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Photo temporarily unavailable.");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(logServerError).toHaveBeenCalledTimes(1);
    expect(logServerError.mock.calls[0]![0]).toBe("ebay.photo_access");
    expect(logServerError.mock.calls[0]![1]).toBeInstanceOf(Error);
  });

  it("passes a resolved response straight through without reporting", async () => {
    configured();
    const served = new Response("bytes", { status: 200 });
    serveEbayPhoto.mockResolvedValue(served);

    await expect(request()).resolves.toBe(served);
    expect(logServerError).not.toHaveBeenCalled();
  });

  it("reports missing configuration instead of reaching Storage", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const response = await request();

    expect(response.status).toBe(503);
    expect(serveEbayPhoto).not.toHaveBeenCalled();
    expect(logServerError).toHaveBeenCalledWith(
      "ebay.photo_access",
      expect.any(Error),
    );
  });

  it("falls through to the legacy key name when the current one is blank", async () => {
    // `(A ?? B)?.trim()` let an empty-string A win and fail the configuration
    // check. Trimming each candidate first is what every other handler does.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "   ");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_legacy");
    serveEbayPhoto.mockResolvedValue(new Response("bytes", { status: 200 }));

    const response = await request();

    expect(response.status).toBe(200);
    expect(serveEbayPhoto).toHaveBeenCalledTimes(1);
  });
});
