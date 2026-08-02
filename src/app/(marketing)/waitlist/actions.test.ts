import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: database.rpc }),
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
    database.rpc.mockReset();
    database.rpc.mockResolvedValue({ data: true, error: null });
  });

  it("stores a valid normalized email through the privileged database path", async () => {
    await expect(
      submitWaitlistSignup({ status: "idle" }, submission("  Aziz@Example.COM  ")),
    ).resolves.toEqual({ status: "success" });

    expect(database.rpc).toHaveBeenCalledWith(
      "insert_waitlist_signup",
      {
        p_email: "aziz@example.com",
        p_rate_limit: expect.any(Number),
      },
    );
  });

  it("returns the same quiet success when the normalized email already exists", async () => {
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

      expect(database.rpc).not.toHaveBeenCalled();
    },
  );

  it("quietly accepts a filled honeypot without writing", async () => {
    await expect(
      submitWaitlistSignup({ status: "idle" }, botSubmission("bot@example.com")),
    ).resolves.toEqual({ status: "success" });

    expect(database.rpc).not.toHaveBeenCalled();
  });

  it("quietly accepts a database-rate-limited submission without a second write path", async () => {
    database.rpc.mockResolvedValue({ data: false, error: null });

    await expect(
      submitWaitlistSignup({ status: "idle" }, submission("person@example.com")),
    ).resolves.toEqual({ status: "success" });

    expect(database.rpc).toHaveBeenCalledTimes(1);
  });
});
