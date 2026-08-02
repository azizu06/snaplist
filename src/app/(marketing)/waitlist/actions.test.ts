import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  from: vi.fn(),
  insert: vi.fn(),
}));
const rateLimit = vi.hoisted(() => ({ limit: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: database.from }),
}));
vi.mock("@/lib/abuse/store", () => ({
  createInMemoryLimiter: () => ({ limit: rateLimit.limit }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "198.51.100.62, 10.0.0.1" }),
}));

import { submitWaitlistSignup } from "./actions";

function submission(email: string): FormData {
  const formData = new FormData();
  formData.set("email", email);
  return formData;
}

function botSubmission(email: string): FormData {
  const formData = submission(email);
  formData.set("company", "Spam Incorporated");
  return formData;
}

describe("waitlist server action", () => {
  beforeEach(() => {
    database.from.mockReset();
    database.insert.mockReset();
    database.from.mockReturnValue({ insert: database.insert });
    database.insert.mockResolvedValue({ error: null });
    rateLimit.limit.mockReset();
    rateLimit.limit.mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      resetMs: 600_000,
    });
  });

  it("stores a valid normalized email through the privileged database path", async () => {
    await expect(
      submitWaitlistSignup({ status: "idle" }, submission("  Aziz@Example.COM  ")),
    ).resolves.toEqual({ status: "success" });

    expect(database.from).toHaveBeenCalledWith("waitlist_signups");
    expect(database.insert).toHaveBeenCalledWith({ email: "aziz@example.com" });
  });

  it("returns the same quiet success when the normalized email already exists", async () => {
    database.insert.mockResolvedValue({
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });

    await expect(
      submitWaitlistSignup({ status: "idle" }, submission("AZIZ@example.com")),
    ).resolves.toEqual({ status: "success" });
  });

  it.each(["", "not-an-email", "missing-domain@", "a".repeat(255) + "@example.com"])(
    "rejects an invalid email server-side without writing it: %s",
    async (email) => {
      await expect(
        submitWaitlistSignup({ status: "idle" }, submission(email)),
      ).resolves.toEqual({ status: "invalid" });

      expect(database.from).not.toHaveBeenCalled();
    },
  );

  it("quietly accepts a filled honeypot without writing", async () => {
    await expect(
      submitWaitlistSignup({ status: "idle" }, botSubmission("bot@example.com")),
    ).resolves.toEqual({ status: "success" });

    expect(database.from).not.toHaveBeenCalled();
    expect(rateLimit.limit).not.toHaveBeenCalled();
  });

  it("quietly accepts a rate-limited submission without writing", async () => {
    rateLimit.limit.mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      resetMs: 300_000,
    });

    await expect(
      submitWaitlistSignup({ status: "idle" }, submission("person@example.com")),
    ).resolves.toEqual({ status: "success" });

    expect(rateLimit.limit).toHaveBeenCalledWith("198.51.100.62");
    expect(database.from).not.toHaveBeenCalled();
  });
});
