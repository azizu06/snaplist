import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { listingReviewProjectionSchema } from "@/lib/listing-review";
import { pricingEvidenceProjectionSchema } from "@/lib/pricing-evidence";
import {
  apiErrorEnvelopeSchema,
  guidedCorrectionEnvelopeSchema,
  mobileRunSchema,
  pricingEvidenceEnvelopeSchema,
} from "./contract";
import {
  guidedCorrectionIntentSchema,
  guidedCorrectionReceiptSchema,
} from "./guided-correction";

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
const VALID_CONTRACT_OWNER_ISSUES = new Set([
  17,
  159,
  161,
  162,
  168,
  173,
  174,
  175,
  240,
  241,
  549,
  628,
]);

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

function dereferenceContractSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dereferenceContractSchema);
  if (!value || typeof value !== "object") return value;
  const schema = value as Record<string, unknown>;
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/components/schemas/", "");
    return dereferenceContractSchema(contract.components.schemas[name]);
  }
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "pattern" || typeof schema.format !== "string")
      .map(([key, nested]) => [
        key === "oneOf" ? "anyOf" : key,
        dereferenceContractSchema(nested),
      ]),
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
    expect(contract.paths["/v1/items/{itemId}/pricing"].get).toMatchObject({
      operationId: "getItemPricing",
      "x-owner-issue": 240,
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }],
    });
    expect(contract.components.schemas).toHaveProperty("PricingEvidenceEnvelope");
    expect(contract.components.schemas).toHaveProperty("PriceResult");
    expect(contract.components.schemas).toHaveProperty("PricingComparable");
    expect(JSON.stringify(contract.paths["/v1/items/runs"])).toContain(
      "#/components/parameters/IdempotencyKey",
    );
    expect(JSON.stringify(contract)).toContain("Idempotency-Key");
  });

  it("publishes the implemented run-bound Listing Review save contract to both mirrors", () => {
    expect(nativeContractSource).toBe(serverContractSource);
    const saveOperation = contract.paths["/v1/runs/{runId}/review"].put;
    expect(saveOperation).toMatchObject({
      operationId: "saveListingReview",
      "x-owner-issue": 549,
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }, { GuestBearer: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ListingReviewSaveIntent",
            },
          },
        },
      },
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ListingReviewSaveEnvelope",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "409": { $ref: "#/components/responses/Conflict" },
        "503": { $ref: "#/components/responses/Unavailable" },
      },
    });
    expect(
      JSON.stringify(contract.paths["/v1/runs/{runId}/review"]),
    ).toContain("#/components/parameters/IdempotencyKey");
    expect(contract.components.schemas.ListingReviewSaveIntent).toMatchObject({
      additionalProperties: false,
      required: [
        "expectedReviewRevision",
        "title",
        "description",
        "condition",
        "specifics",
        "sellerPriceOverride",
      ],
      properties: {
        expectedReviewRevision: { type: "string", format: "uuid" },
        title: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string", minLength: 1, maxLength: 20_000 },
        condition: {
          type: "string",
          enum: [
            "new",
            "like-new",
            "very-good",
            "good",
            "acceptable",
            "fair",
            "poor",
            "for-parts",
          ],
        },
        specifics: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            additionalProperties: false,
            required: ["name", "value"],
          },
        },
        sellerPriceOverride: {
          anyOf: [
            { type: "number", minimum: 0.01, multipleOf: 0.01 },
            { type: "null" },
          ],
        },
      },
    });
    expect(contract.components.schemas.ListingReviewSaveReceipt).toEqual({
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "runId",
        "itemId",
        "listingId",
        "reviewRevision",
      ],
      properties: {
        schemaVersion: { const: 1 },
        runId: { type: "string", format: "uuid" },
        itemId: { type: "string", format: "uuid" },
        listingId: { type: "string", format: "uuid" },
        reviewRevision: { type: "string", format: "uuid" },
      },
    });
  });

  it("documents the exact eBay OAuth callback vocabulary in both OpenAPI copies", () => {
    const callback = contract.paths["/v1/ebay/oauth/callback"].get as {
      responses: { "303": { description: string } };
    };

    expect(nativeContractSource).toBe(serverContractSource);
    expect(callback.responses["303"].description).toBe(
      "Redirects to an app universal link carrying exactly one opaque result: connected, declined, cancelled, expired, wrong_tenant, invalid_state, in_progress, or failed. in_progress is a truthful nonterminal result and does not imply connection success or failure.",
    );
  });

  it("publishes only server-owned eBay preflight, exact-once, status, and disconnect truth", () => {
    expect(nativeContractSource).toBe(serverContractSource);
    const preflight = contract.paths["/v1/listings/{listingId}/ebay/preflight"]
      .get as Record<string, unknown>;
    const publish = contract.paths["/v1/listings/{listingId}/ebay/publish"];
    const connection = contract.paths["/v1/ebay/connection"];
    expect(preflight).toMatchObject({
      "x-owner-issue": 628,
      "x-implementation-status": "implemented",
    });
    expect(publish.get).toMatchObject({
      "x-owner-issue": 628,
      "x-implementation-status": "implemented",
    });
    expect(publish.post).toMatchObject({
      "x-owner-issue": 628,
      "x-implementation-status": "implemented",
      responses: { "409": { $ref: "#/components/responses/Conflict" } },
    });
    expect(connection.get).toMatchObject({
      "x-owner-issue": 628,
      "x-implementation-status": "implemented",
    });
    expect(connection.delete).toMatchObject({
      "x-owner-issue": 628,
      "x-implementation-status": "implemented",
    });

    const preflightSchema = contract.components.schemas.EbayPublishPreflight;
    const preflightProperties = preflightSchema.properties as Record<
      string,
      unknown
    >;
    expect(preflightSchema.required).toEqual([
      "listingId",
      "title",
      "effectivePrice",
      "photoCount",
      "marketplace",
      "ebayCondition",
      "itemSpecifics",
      "reviewRevision",
      "connection",
      "publishEligibility",
    ]);
    expect(preflightProperties.connection).toEqual({
      $ref: "#/components/schemas/EbayConnectionStatus",
    });
    expect(preflightProperties.publishEligibility).toMatchObject({
      required: ["enabled", "eligible"],
      additionalProperties: false,
    });
    expect(preflightProperties).not.toHaveProperty("categoryId");
    expect(preflightProperties).not.toHaveProperty("currency");
    expect(
      (contract.components.schemas.EbayPublishStatus.properties as {
        outcome: { enum: string[] };
      }).outcome.enum,
    ).toContain("outcome_not_yet_known");
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

  it("keeps one native decode fixture on the exact runtime pricing envelope", () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve("ios/SnapListTests/Fixtures/pricing-evidence-response.json"),
        "utf8",
      ),
    );

    expect(() => pricingEvidenceEnvelopeSchema.parse(fixture)).not.toThrow();
    expect(fixture.data.comparables).toHaveLength(2);
    expect(fixture.data.comparables[1]).not.toHaveProperty("soldAt");
  });

  it("keeps zero payout valid while preserving the public nonnegative boundary", () => {
    const boundary = JSON.parse(
      readFileSync(
        resolve("ios/SnapListTests/Fixtures/pricing-evidence-response.json"),
        "utf8",
      ),
    );
    boundary.data.priceResult.suggested = 0.01;
    boundary.data.priceResult.range = { min: 0.01, max: 0.01 };
    boundary.data.estimatedFees = 0.3;
    boundary.data.estimatedPayout = 0;

    expect(() => pricingEvidenceEnvelopeSchema.parse(boundary)).not.toThrow();
    expect(
      contract.components.schemas.PricingEvidenceProjection.properties,
    ).toMatchObject({
      estimatedPayout: { type: "number", minimum: 0 },
    });

    boundary.data.estimatedPayout = -0.01;
    expect(() => pricingEvidenceEnvelopeSchema.parse(boundary)).toThrow();
  });

  it("keeps the item-pricing OpenAPI projection byte-for-byte aligned with runtime JSON Schema", () => {
    const generatedRuntimeSchema = z.toJSONSchema(
      pricingEvidenceProjectionSchema,
    ) as Record<string, unknown>;
    delete generatedRuntimeSchema.$schema;
    const runtimeSchema = dereferenceContractSchema(generatedRuntimeSchema);
    const openApiSchema = dereferenceContractSchema(
      contract.components.schemas.PricingEvidenceProjection,
    );

    expect(openApiSchema).toEqual(runtimeSchema);
  });

  it("keeps #597's guided correction schemas aligned with runtime JSON Schema", () => {
    // The three schemas this route publishes were declared by hand and asserted
    // by nothing, so the runtime accepted a confirmed identity a third longer
    // than the contract allows — a value a native client generated from this
    // file would refuse to send, and would refuse to decode once stored.
    const pairs: [string, z.ZodType][] = [
      ["GuidedCorrectionIntent", guidedCorrectionIntentSchema],
      ["GuidedCorrectionReceipt", guidedCorrectionReceiptSchema],
      ["GuidedCorrectionEnvelope", guidedCorrectionEnvelopeSchema],
    ];

    for (const [name, schema] of pairs) {
      const generatedRuntimeSchema = z.toJSONSchema(schema) as Record<
        string,
        unknown
      >;
      delete generatedRuntimeSchema.$schema;

      expect({
        [name]: dereferenceContractSchema(contract.components.schemas[name]),
      }).toEqual({ [name]: dereferenceContractSchema(generatedRuntimeSchema) });
    }
  });

  it("requires an Idempotency-Key on the guided correction it pays a provider for", () => {
    // A POST that spends real pricing budget has to be replayable, or a client
    // retry is billed twice for one seller intent.
    expect(
      JSON.stringify(contract.paths["/v1/runs/{runId}/sharpen"]),
    ).toContain("#/components/parameters/IdempotencyKey");
  });

  it("keeps #376's run review and principal contract aligned with runtime JSON Schema", () => {
    expect(contract.paths["/v1/runs/{runId}"].get).toMatchObject({
      "x-owner-issue": 241,
      "x-related-owner-issues": expect.arrayContaining([376]),
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }, { GuestBearer: [] }],
    });
    expect(contract.components.schemas.PipelineRun).toMatchObject({
      properties: {
        review: { $ref: "#/components/schemas/ListingReviewProjection" },
      },
    });

    const generatedRuntimeSchema = z.toJSONSchema(
      listingReviewProjectionSchema,
    ) as Record<string, unknown>;
    delete generatedRuntimeSchema.$schema;
    const runtimeSchema = dereferenceContractSchema(generatedRuntimeSchema);
    const openApiSchema = dereferenceContractSchema(
      contract.components.schemas.ListingReviewProjection,
    );

    expect(openApiSchema).toEqual(runtimeSchema);

    const pricingEvidenceRecord = contract.components.schemas
      .PricingEvidenceRecord as {
        properties: { photoUrl: { pattern?: string } };
      };
    const pricingComparable = contract.components.schemas.PricingComparable as {
      properties: { photoUrl: { pattern?: string } };
    };
    const listingReview = contract.components.schemas.ListingReviewProjection as {
      properties: {
        verifiedSoldMatches: {
          items: { properties: { photoURL: { pattern?: string } } };
        };
      };
    };
    const photoSchemas = [
      pricingEvidenceRecord.properties.photoUrl,
      pricingComparable.properties.photoUrl,
      listingReview.properties.verifiedSoldMatches.items.properties.photoURL,
    ] as Array<{ pattern?: string }>;
    for (const photoSchema of photoSchemas) {
      expect(photoSchema.pattern).toEqual(expect.any(String));
      const httpsOnly = new RegExp(photoSchema.pattern!);
      expect(httpsOnly.test("https://i.ebayimg.com/item.jpg")).toBe(true);
      expect(httpsOnly.test("http://i.ebayimg.com/item.jpg")).toBe(false);
    }
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

  it("keeps #175's claim result terminal and prevents clients from setting TTL or ownership", () => {
    const claim = contract.paths["/v1/guest/claims"].post as Record<string, unknown>;
    expect(claim).toMatchObject({
      "x-owner-issue": 175,
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }],
      responses: {
        "400": { $ref: "#/components/responses/InvalidRequest" },
      },
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
          oneOf: [
            { $ref: "#/components/schemas/GuestClaimClaimedOutcome" },
            { $ref: "#/components/schemas/GuestClaimExpiredOutcome" },
          ],
        },
      },
    });
    expect(contract.components.schemas.GuestClaimClaimedOutcome).toMatchObject({
      required: expect.arrayContaining(["accountRecovery"]),
      properties: { outcome: { const: "claimed" } },
    });
  });

  it("marks the three #241 run operations implemented with the canonical DTO", () => {
    expect(contract.paths["/v1/runs/{runId}"].get).toMatchObject({
      "x-owner-issue": 241,
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }, { GuestBearer: [] }],
    });
    for (const [path, method] of [
      ["/v1/runs/{runId}/retry", "post"],
      ["/v1/runs/{runId}/cancel", "post"],
    ] as const) {
      expect(contract.paths[path][method]).toMatchObject({
        "x-owner-issue": 241,
        "x-implementation-status": "implemented",
        security: [{ ClerkBearer: [] }],
      });
    }
    expect(contract.components.schemas.PipelineRun).toMatchObject({
      required: expect.arrayContaining([
        "id",
        "itemId",
        "listingId",
        "status",
        "stage",
        "attemptCount",
        "maxAttempts",
        "schemaVersion",
        "timestamps",
        "requiredInput",
        "terminalOutcome",
        "safeFailure",
        "allowance",
        "legalActions",
        "lastMeaningfulUpdateAt",
        "retentionCleanedAt",
      ]),
    });
    expect(JSON.stringify(contract.components.schemas.PipelineRun)).not.toMatch(
      /percentage|progress|eta/i,
    );
  });

  it("keeps the implemented run OpenAPI schema aligned with runtime Zod", () => {
    const openApiRun = contract.components.schemas.PipelineRun as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        status: { enum: string[] };
        stage: { enum: string[] };
        allowance: { enum: string[] };
      };
    };
    const zodRequired = Object.entries(mobileRunSchema.shape)
      .filter(([, schema]) => !schema.safeParse(undefined).success)
      .map(([name]) => name)
      .sort();

    expect(openApiRun.additionalProperties).toBe(false);
    expect([...openApiRun.required].sort()).toEqual(zodRequired);
    expect(openApiRun.properties.status.enum).toEqual(mobileRunSchema.shape.status.options);
    expect(openApiRun.properties.stage.enum).toEqual(mobileRunSchema.shape.stage.options);
    expect(openApiRun.properties.allowance.enum).toEqual(mobileRunSchema.shape.allowance.options);
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

  it("marks both #387 per-user eBay OAuth operations implemented", () => {
    expect(contract.paths["/v1/ebay/oauth/sessions"].post).toMatchObject({
      "x-owner-issue": 387,
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }],
    });
    expect(contract.paths["/v1/ebay/oauth/callback"].get).toMatchObject({
      "x-owner-issue": 387,
      "x-implementation-status": "implemented",
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
