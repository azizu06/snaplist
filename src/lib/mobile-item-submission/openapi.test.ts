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
      security: [{ ClerkBearer: [] }, { GuestBearer: [] }],
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
        "403": expect.any(Object),
        "409": expect.any(Object),
        "429": expect.any(Object),
        "503": expect.any(Object),
      },
    });
    expect(operation.security).toContainEqual({ GuestBearer: [] });
    expect(serialized).not.toMatch(/user_?id|storage_?path|fingerprint/i);
    expect(contract.components.schemas.CreateItemRunMultipart).toMatchObject({
      required: ["photo"],
      properties: {
        photo: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", format: "binary" },
        },
        voiceContext: {
          type: "string",
          format: "binary",
        },
        voiceContextLocale: {
          type: "string",
          maxLength: 255,
        },
      },
    });
    expect(contract.components.schemas.MobileItemSubmissionReceipt).toMatchObject({
      required: expect.arrayContaining([
        "runId",
        "photoIdentity",
        "photos",
        "voiceContext",
      ]),
      properties: {
        photos: { minItems: 1, maxItems: 5 },
        voiceContext: {
          oneOf: expect.arrayContaining([{ type: "null" }]),
        },
      },
    });
    expect(contract.components.schemas.MobileItemSubmissionVoiceReceipt)
      .toMatchObject({
        required: [
          "version",
          "contentSha256",
          "byteLength",
          "durationMs",
          "mediaType",
        ],
        properties: {
          byteLength: { maximum: 524288 },
          durationMs: { maximum: 15000 },
          mediaType: { const: "audio/wav" },
        },
      });
    expect(contract.components.schemas.MobileItemSubmissionPhoto).toMatchObject({
      properties: { ordinal: { minimum: 0, maximum: 4 } },
    });
    expect(contract.components.schemas.GuestClaimAccountRecovery).toMatchObject({
      properties: { storageManifest: { minItems: 1, maxItems: 5 } },
    });
  });

  it("keeps the native contract inventory and receipt fixture aligned", () => {
    const nativeModels = readFileSync(
      "ios/SnapList/Core/API/MobileAPIModels.swift",
      "utf8",
    );
    const fixture = JSON.parse(readFileSync(
      "ios/DesignContracts/V1/mobile-item-submission-response.json",
      "utf8",
    ));

    expect(nativeModels).not.toMatch(/case createItemRun/);
    expect(nativeModels).toContain("struct MobileItemSubmissionEnvelope");
    expect(fixture.data.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.data.photoIdentity.kind).toBe("content_sha256_set_v1");
    expect(fixture.data.voiceContext).toBeNull();
    expect(fixture.data.photos.map((photo: { ordinal: number }) => photo.ordinal)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});
