import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { apiErrorEnvelopeSchema } from "./contract";

const serverContractSource = readFileSync(
  resolve("docs/contracts/mobile-api-v1.openapi.json"),
  "utf8",
);
const nativeContractSource = readFileSync(
  resolve("ios/DesignContracts/V1/mobile-api-v1.openapi.json"),
  "utf8",
);
const contract = JSON.parse(serverContractSource) as {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, { description?: string }>;
    schemas: Record<string, Record<string, unknown>>;
  };
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const VALID_CONTRACT_OWNER_ISSUES = new Set([17, 159, 161, 162, 168, 173, 174, 175]);

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

function primitiveSchemaAccepts(
  schema: { type?: string | string[]; minimum?: number },
  value: unknown,
): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) return types.includes("null");
  if (Number.isInteger(value) && types.includes("integer")) {
    return schema.minimum == null || (value as number) >= schema.minimum;
  }
  return false;
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
    expect(contract.paths).toHaveProperty("/v1/guest/claims");
    expect(contract.paths).toHaveProperty("/v1/ebay/oauth/callback");
    expect(contract.paths).toHaveProperty("/v1/webhooks/revenuecat");
    expect(contract.paths).toHaveProperty("/v1/billing/revenuecat/identity");
    expect(contract.paths["/v1/home"].get).toMatchObject({
      operationId: "getHome",
      "x-owner-issue": 208,
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }],
    });
    expect(contract.components.schemas).toHaveProperty("HomeEnvelope");
    expect(JSON.stringify(contract.paths["/v1/items/runs"])).toContain(
      "#/components/parameters/IdempotencyKey",
    );
    expect(JSON.stringify(contract)).toContain("Idempotency-Key");
  });

  it("keeps both OpenAPI copies byte-identical and validates unavailable Home order truth", () => {
    expect(nativeContractSource).toBe(serverContractSource);
    const homeSummary = contract.components.schemas.HomeSummary as {
      properties: {
        orders: { type?: string | string[]; minimum?: number };
      };
    };
    const response = { data: { summary: { active: 2, drafts: 1, orders: null } } };

    expect(homeSummary.properties.orders).toEqual({
      type: ["integer", "null"],
      minimum: 0,
    });
    expect(
      primitiveSchemaAccepts(
        homeSummary.properties.orders,
        response.data.summary.orders,
      ),
    ).toBe(true);
    expect(primitiveSchemaAccepts(homeSummary.properties.orders, 0)).toBe(true);
  });

  it("documents the standard Clerk token checks without inventing an audience", () => {
    const description =
      contract.components.securitySchemes.ClerkBearer.description ?? "";

    expect(description).toMatch(/issuer/i);
    expect(description).toMatch(/signature/i);
    expect(description).toMatch(/expiry/i);
    expect(description).toMatch(/subject/i);
    expect(description).toMatch(/authorized-part/i);
    expect(description).not.toMatch(/audience/i);
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
    for (const issue of [17, 159, 161, 162, 168, 173, 174, 175]) {
      expect(serialized).toContain(`\"x-owner-issue\":${issue}`);
    }
  });

  it("keeps #175's claim result terminal and prevents clients from setting TTL or ownership", () => {
    const claim = contract.paths["/v1/guest/claims"].post as Record<string, unknown>;
    expect(claim).toMatchObject({
      "x-owner-issue": 175,
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }],
    });
    expect(JSON.stringify(claim)).toContain("X-SnapList-Guest-Handoff");
    expect(JSON.stringify(claim)).toContain(
      "#/components/parameters/IdempotencyKey",
    );
    expect(JSON.stringify(claim)).not.toContain("expiresAt");
    expect(JSON.stringify(claim)).not.toContain("targetUserId");
    expect(contract.components.schemas.GuestClaimEnvelope).toMatchObject({
      properties: {
        data: {
          properties: {
            outcome: { enum: ["claimed", "expired"] },
            purgeLocalRecovery: { const: true },
          },
        },
      },
    });
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
        if (!content) continue;
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
