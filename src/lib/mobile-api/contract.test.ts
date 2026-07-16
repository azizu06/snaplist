import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { apiErrorEnvelopeSchema } from "./contract";

const contract = JSON.parse(
  readFileSync(resolve("docs/contracts/mobile-api-v1.openapi.json"), "utf8"),
) as {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
};

describe("SwiftUI mobile HTTP contract", () => {
  it("is explicitly versioned and independent from Next.js route names", () => {
    expect(contract.info.version).toBe("1.0.0");
    expect(Object.keys(contract.paths).every((path) => path.startsWith("/v1/") || path.startsWith("/internal/v1/"))).toBe(true);
    expect(JSON.stringify(contract)).not.toContain("/api/");
    expect(JSON.stringify(contract).toLowerCase()).not.toContain("nextresponse");
  });

  it("defines bearer JWT, idempotency, stable errors, and provider callbacks", () => {
    expect(contract.components.securitySchemes).toHaveProperty("ClerkBearer");
    expect(contract.components.schemas).toHaveProperty("ErrorEnvelope");
    expect(contract.paths).toHaveProperty("/v1/items/runs");
    expect(contract.paths).toHaveProperty("/v1/ebay/oauth/callback");
    expect(contract.paths).toHaveProperty("/v1/webhooks/storekit");
    expect(JSON.stringify(contract.paths["/v1/items/runs"])).toContain(
      "#/components/parameters/IdempotencyKey",
    );
    expect(JSON.stringify(contract)).toContain("Idempotency-Key");
  });

  it.each(["conflict", "rate_limited"])(
    "can emit the documented %s error code",
    (code) => {
      expect(() =>
        apiErrorEnvelopeSchema.parse({
          error: { code, message: "Stable native error.", requestId: "req_test" },
        }),
      ).not.toThrow();
    },
  );

  it("keeps future implementation ownership explicit in the contract", () => {
    const serialized = JSON.stringify(contract);
    for (const issue of [159, 161, 162, 168, 173, 174]) {
      expect(serialized).toContain(`\"x-owner-issue\":${issue}`);
    }
  });
});
