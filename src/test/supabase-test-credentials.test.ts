import { describe, expect, it } from "vitest";
import { resolveTenantServerTestApiKey } from "./supabase-test-credentials";

describe("tenant-bound server test credentials", () => {
  it("uses only a current Supabase secret API key for the server authorization header", () => {
    expect(
      resolveTenantServerTestApiKey({
        SUPABASE_SECRET_KEY: "sb_secret_current",
        SUPABASE_SERVICE_ROLE_KEY: "eyJlegacy-service-role-jwt",
      }),
    ).toBe("sb_secret_current");

    expect(() =>
      resolveTenantServerTestApiKey({
        SUPABASE_SERVICE_ROLE_KEY: "eyJlegacy-service-role-jwt",
      }),
    ).toThrow(/SECRET_KEY.*sb_secret_/i);
  });
});
