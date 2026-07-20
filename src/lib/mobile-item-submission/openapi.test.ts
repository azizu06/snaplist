import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync("docs/contracts/mobile-api-v1.openapi.json", "utf8");
const nativeSource = readFileSync("ios/DesignContracts/V1/mobile-api-v1.openapi.json", "utf8");
const contract = JSON.parse(serverSource);

describe("mobile item submission OpenAPI", () => {
  it("publishes the exact implemented multipart boundary without client ownership inputs", () => {
    const operation = contract.paths["/v1/items/runs"].post;
    const serialized = JSON.stringify(operation);

    expect(nativeSource).toBe(serverSource);
    expect(operation).toMatchObject({
      "x-owner-issue": 334,
      "x-implementation-status": "implemented",
      security: [{ ClerkBearer: [] }],
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: { $ref: "#/components/schemas/CreateItemRunMultipart" },
          },
        },
      },
      responses: {
        "200": expect.any(Object),
        "202": expect.any(Object),
        "409": expect.any(Object),
        "503": expect.any(Object),
      },
    });
    expect(operation.security).not.toContainEqual({ GuestBearer: [] });
    expect(serialized).not.toMatch(/user_?id|storage_?path|fingerprint/i);
    expect(contract.components.schemas.CreateItemRunMultipart).toMatchObject({
      required: ["photo"],
      properties: {
        photo: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: { type: "string", format: "binary" },
        },
      },
    });
    expect(contract.components.schemas.MobileItemSubmissionReceipt).toMatchObject({
      required: expect.arrayContaining(["runId", "photoIdentity", "photos"]),
    });
  });
});
