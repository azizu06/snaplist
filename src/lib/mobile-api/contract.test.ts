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
    schemas: Record<string, Record<string, unknown>>;
  };
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const VALID_CONTRACT_OWNER_ISSUES = new Set([17, 159, 161, 162, 168, 173, 174]);

function operations() {
  return Object.entries(contract.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => ({
        path,
        method,
        operation: operation as Record<string, unknown>,
      })),
  );
}

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
    for (const issue of [17, 159, 161, 162, 168, 173, 174]) {
      expect(serialized).toContain(`\"x-owner-issue\":${issue}`);
    }
  });

  it("assigns every contract-only operation to an explicit issue owner", () => {
    for (const { path, method, operation } of operations()) {
      if (operation["x-implementation-status"] !== "contract-only") continue;
      expect(
        operation["x-owner-issue"],
        `${method.toUpperCase()} ${path} must declare x-owner-issue`,
      ).toBeTypeOf("number");
      expect(
        VALID_CONTRACT_OWNER_ISSUES.has(operation["x-owner-issue"] as number),
        `${method.toUpperCase()} ${path} must reference a verified live owner`,
      ).toBe(true);
    }
  });

  it("keeps both per-user eBay OAuth operations owned by issue 17", () => {
    expect(contract.paths["/v1/ebay/oauth/sessions"].post).toMatchObject({
      "x-owner-issue": 17,
    });
    expect(contract.paths["/v1/ebay/oauth/callback"].get).toMatchObject({
      "x-owner-issue": 17,
    });
  });

  it("gives every body-bearing success a typed envelope with request metadata", () => {
    expect(contract.components.schemas.ResponseMeta).toMatchObject({
      required: expect.arrayContaining(["requestId"]),
      properties: { requestId: { type: "string" } },
    });
    for (const { path, method, operation } of operations()) {
      const responses = operation.responses as
        | Record<string, Record<string, unknown>>
        | undefined;
      for (const [status, response] of Object.entries(responses ?? {})) {
        const code = Number(status);
        if (code < 200 || code >= 300 || code === 204) continue;
        const content = response.content as
          | Record<string, { schema?: { $ref?: string } }>
          | undefined;
        const schemaRef = content?.["application/json"]?.schema?.$ref;
        expect(
          schemaRef,
          `${method.toUpperCase()} ${path} ${status} must use a typed JSON envelope`,
        ).toMatch(/^#\/components\/schemas\/.+Envelope$/);
        const schemaName = schemaRef?.split("/").at(-1);
        const schema = schemaName ? contract.components.schemas[schemaName] : undefined;
        expect(
          schema,
          `${method.toUpperCase()} ${path} ${status} references a missing envelope`,
        ).toMatchObject({
          required: expect.arrayContaining(["data", "meta"]),
          properties: {
            meta: { $ref: "#/components/schemas/ResponseMeta" },
          },
        });
      }
    }
  });
});
