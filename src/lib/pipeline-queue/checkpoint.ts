import { z } from "zod";
import {
  extractedAttributesSchema,
  identificationSchema,
  listingCopySchema,
} from "@/lib/pipeline/types";
import { priceResultSchema } from "@/lib/pricing";
import { durablePriceEvidenceSchema } from "@/lib/pricing/approved-sold-provider";

export const PIPELINE_CHECKPOINT_MAX_JSONB_BYTES = 262_144;

function isPostgresJsonbSafeString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function postgresUnsafeJsonStringPath(
  value: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
  if (typeof value === "string") {
    return isPostgresJsonbSafeString(value) ? null : path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const unsafe = postgresUnsafeJsonStringPath(value[index], [...path, index]);
      if (unsafe) return unsafe;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (!isPostgresJsonbSafeString(key)) return [...path, key];
      const unsafe = postgresUnsafeJsonStringPath(entry, [...path, key]);
      if (unsafe) return unsafe;
    }
  }
  return null;
}

function jsonbWhitespaceBytes(value: unknown): number {
  if (Array.isArray(value)) {
    return (
      Math.max(0, value.length - 1) +
      value.reduce((total, entry) => total + jsonbWhitespaceBytes(entry), 0)
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.values(value).filter(
      (entry) => entry !== undefined,
    );
    return (
      entries.length +
      Math.max(0, entries.length - 1) +
      entries.reduce((total, entry) => total + jsonbWhitespaceBytes(entry), 0)
    );
  }
  return 0;
}

function postgresJsonbNumberText(value: number): string {
  const serialized = JSON.stringify(value);
  const match = serialized.match(
    /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/,
  );
  if (!match) return serialized;

  const [, sign, integer, fraction = "", rawExponent] = match;
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + Number(rawExponent);
  if (decimalIndex <= 0) {
    return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function jsonbNumericExpansionBytes(value: unknown): number {
  if (typeof value === "number") {
    return postgresJsonbNumberText(value).length - JSON.stringify(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (total, entry) => total + jsonbNumericExpansionBytes(entry),
      0,
    );
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (total, entry) => total + jsonbNumericExpansionBytes(entry),
      0,
    );
  }
  return 0;
}

/** Match PostgreSQL `octet_length(jsonb::text)` before attempting the RPC. */
export function pipelineCheckpointJsonbByteLength(value: unknown): number {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength +
    jsonbWhitespaceBytes(value) +
    jsonbNumericExpansionBytes(value)
  );
}

export const identifiedPipelineStageSchema = z
  .object({
    attributes: extractedAttributesSchema,
    identification: identificationSchema.optional(),
    model: z.string().min(1),
  })
  .strict();

export const generatedPipelineStageSchema = z
  .object({
    copy: listingCopySchema,
    model: z.string().min(1),
  })
  .strict();

export const pipelineWorkerCheckpointSchema = z
  .object({
    identified: identifiedPipelineStageSchema.optional(),
    priced: priceResultSchema.optional(),
    /** Compact service-role-written projection consumed only by the RLS loader. */
    priceEvidence: durablePriceEvidenceSchema.optional(),
    generated: generatedPipelineStageSchema.optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const unsafeStringPath = postgresUnsafeJsonStringPath(checkpoint);
    if (unsafeStringPath) {
      context.addIssue({
        code: "custom",
        message:
          "Pipeline checkpoint contains text PostgreSQL JSONB cannot encode",
        path: unsafeStringPath,
      });
    }
    if (
      pipelineCheckpointJsonbByteLength(checkpoint) >
      PIPELINE_CHECKPOINT_MAX_JSONB_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Pipeline checkpoint exceeds the database byte limit",
        path: [],
      });
    }
    if (checkpoint.priced && !checkpoint.identified) {
      context.addIssue({
        code: "custom",
        message: "A pricing checkpoint requires an identification checkpoint",
        path: ["priced"],
      });
    }
    if (checkpoint.generated && !checkpoint.identified) {
      context.addIssue({
        code: "custom",
        message: "A generation checkpoint requires an identification checkpoint",
        path: ["generated"],
      });
    }
    if (checkpoint.priceEvidence && !checkpoint.priced) {
      context.addIssue({
        code: "custom",
        message: "A price-evidence checkpoint requires a pricing checkpoint",
        path: ["priceEvidence"],
      });
    }
  });

export type IdentifiedPipelineStage = z.infer<typeof identifiedPipelineStageSchema>;
export type GeneratedPipelineStage = z.infer<typeof generatedPipelineStageSchema>;
export type PipelineWorkerCheckpoint = z.infer<typeof pipelineWorkerCheckpointSchema>;
