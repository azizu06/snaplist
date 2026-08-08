import "server-only";

import { z } from "zod";
import type {
  AppAttestVerificationResult,
  createAppAttestService,
} from "./service";

type AppAttestService = ReturnType<typeof createAppAttestService>;

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

const keyId = z.string().max(512).refine(isCanonicalBase64);
const evidenceObject = z.string().max(128_000).refine(isCanonicalBase64);
const clientData = z.string().max(8_192).refine(isCanonicalBase64);
const requestBody = z.string().max(1_400_000).refine(isCanonicalBase64);

const challengeRequest = z
  .object({
    keyId: keyId.optional(),
    kind: z.enum(["attestation", "assertion"]),
    operation: z.literal("challenge"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.kind === "attestation" && value.keyId !== undefined) ||
      (value.kind === "assertion" && value.keyId === undefined)
    ) {
      context.addIssue({ code: "custom", message: "Invalid challenge key binding" });
    }
  });

const attestationRequest = z
  .object({
    attestationObject: evidenceObject,
    challengeId: z.string().uuid(),
    keyId,
    operation: z.literal("attestation"),
  })
  .strict();

const assertionRequest = z
  .object({
    assertionObject: evidenceObject,
    challengeId: z.string().uuid(),
    clientData: clientData.optional(),
    keyId,
    operation: z.literal("assertion"),
    requestBody,
  })
  .strict();

const requestSchema = z.discriminatedUnion("operation", [
  challengeRequest,
  attestationRequest,
  assertionRequest,
]);

function invalidRequest(): Response {
  return Response.json(
    { data: { code: "invalid_request", status: "invalid" } },
    { status: 400 },
  );
}

export function createAppAttestHttpHandler(
  dependency: AppAttestService | (() => AppAttestService),
  options: {
    issueGuestCapability?: (
      assertion: Extract<
        AppAttestVerificationResult,
        { kind: "assertion"; status: "verified" }
      >,
    ) => Promise<{
      bearerToken: string;
      expiresAt: string;
      refreshAfter: string;
    }>;
  } = {},
) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return invalidRequest();
    const rawBody = await request.text().catch(() => "");
    if (rawBody.length === 0 || rawBody.length > 1_600_000) return invalidRequest();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return invalidRequest();
    }
    const parsed = requestSchema.safeParse(parsedJson);
    if (!parsed.success) return invalidRequest();

    try {
      const service =
        typeof dependency === "function" ? dependency() : dependency;
      if (parsed.data.operation === "challenge") {
        const data = await service.issueChallenge({
          keyId: parsed.data.keyId,
          kind: parsed.data.kind,
        });
        return Response.json({ data });
      }
      if (parsed.data.operation === "attestation") {
        const data = await service.verifyAttestation(parsed.data);
        return Response.json({ data }, { status: data.status === "verified" ? 200 : 401 });
      }

      const data = await service.verifyAssertion({
        assertionObject: parsed.data.assertionObject,
        challengeId: parsed.data.challengeId,
        clientData: parsed.data.clientData
          ? Buffer.from(parsed.data.clientData, "base64")
          : undefined,
        keyId: parsed.data.keyId,
        requestBody: Buffer.from(parsed.data.requestBody, "base64"),
      });
      if (data.status !== "verified" || data.kind !== "assertion") {
        return Response.json({ data }, { status: 401 });
      }
      const guestCapability = options.issueGuestCapability
        ? await options.issueGuestCapability(data)
        : undefined;
      return Response.json({
        data: guestCapability ? { ...data, guestCapability } : data,
      });
    } catch {
      return Response.json(
        { data: { code: "service_unavailable", status: "unavailable" } },
        { status: 503 },
      );
    }
  };
}
