import { describe, expect, it } from "vitest";
import { createConfiguredMobileItemSubmissionOperations } from "./configured";

const baseInput = {
  supabaseURL: "https://project.supabase.co",
  publishableKey: "sb_publishable_current",
  secretKey: "sb_secret_current",
};

describe("configured mobile item submission", () => {
  it("accepts only current Supabase publishable and secret key formats", () => {
    expect(() => createConfiguredMobileItemSubmissionOperations(baseInput)).not.toThrow();
  });

  it.each([
    {
      name: "legacy service-role JWT",
      input: { ...baseInput, secretKey: "eyJhbGciOiJIUzI1NiJ9.legacy" },
      message: /current Supabase secret key/,
    },
    {
      name: "legacy anon JWT",
      input: { ...baseInput, publishableKey: "eyJhbGciOiJIUzI1NiJ9.legacy" },
      message: /current Supabase publishable key/,
    },
    {
      name: "missing secret",
      input: { ...baseInput, secretKey: "" },
      message: /current Supabase secret key/,
    },
    {
      name: "missing publishable key",
      input: { ...baseInput, publishableKey: "" },
      message: /current Supabase publishable key/,
    },
  ])("rejects $name", ({ input, message }) => {
    expect(() => createConfiguredMobileItemSubmissionOperations(input)).toThrow(message);
  });
});
