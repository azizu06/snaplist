import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeErrorForLog } from "./log-safe-error";
import { PipelineWorkerFailure } from "./worker";

/**
 * The sentence a seller spoke. It reaches these errors the way it reaches the
 * real ones — echoed back by a provider, or reported as the value a schema
 * rejected — and must not survive into the returned line.
 */
const TRANSCRIPT = "scratch on left hinge";

describe("describeErrorForLog", () => {
  it("keeps the type and codes an operator needs to tell one failure from another", () => {
    const described = describeErrorForLog(
      new PipelineWorkerFailure({
        code: "provider_usage_temporarily_unavailable",
        safeMessage: "SnapList could not finish this listing yet.",
        retryable: true,
      }),
    );

    expect(described).toContain("PipelineWorkerFailure");
    expect(described).toContain("code=provider_usage_temporarily_unavailable");
    expect(described).toContain("retryable=true");
  });

  it("drops the message even when it is the only thing the error carries", () => {
    const described = describeErrorForLog(
      new Error(`provider echoed transcript ${TRANSCRIPT} and raw payload`),
    );

    expect(described).not.toContain(TRANSCRIPT);
    expect(described).not.toContain("raw payload");
    expect(described).toBe("Error");
  });

  it("reports a rejected schema by issue kind without repeating the rejected value or its path", () => {
    const schema = z.object({ title: z.string(), notes: z.record(z.string(), z.string()) });
    const parsed = schema.safeParse({ title: 42, notes: { [TRANSCRIPT]: 7 } });
    expect(parsed.success).toBe(false);

    const described = describeErrorForLog(parsed.error);

    expect(described).toContain("ZodError");
    expect(described).toContain("issue_codes=invalid_type");
    expect(described).toContain("issues=2");
    // The value 42 was rejected under `title`; the offending record key is the
    // transcript itself. Neither is ours to log.
    expect(described).not.toContain(TRANSCRIPT);
    expect(described).not.toContain("title");
  });

  it("keeps the SQLSTATE and status a storage rejection carries, and none of its prose", () => {
    const postgrest = Object.assign(new Error(`duplicate key value ${TRANSCRIPT}`), {
      code: "23505",
      status: 409,
      details: `Key (transcript)=(${TRANSCRIPT}) already exists.`,
      hint: TRANSCRIPT,
    });

    const described = describeErrorForLog(postgrest);

    expect(described).toContain("code=23505");
    expect(described).toContain("status=409");
    expect(described).not.toContain(TRANSCRIPT);
  });

  it("walks the cause chain, which is where a transport failure hides its real code", () => {
    const described = describeErrorForLog(
      new Error(`fetch failed for ${TRANSCRIPT}`, {
        cause: Object.assign(new Error(TRANSCRIPT), { code: "ECONNRESET" }),
      }),
    );

    expect(described).toBe("Error cause=(Error code=ECONNRESET)");
    expect(described).not.toContain(TRANSCRIPT);
  });

  it("stops walking a cyclic cause chain instead of hanging", () => {
    const outer = new Error("outer") as Error & { cause?: unknown };
    outer.cause = outer;

    expect(describeErrorForLog(outer)).toBe(
      "Error cause=(Error cause=(Error cause=(Error)))",
    );
  });

  it("refuses a code that is prose wearing a code's name", () => {
    const described = describeErrorForLog(
      Object.assign(new Error("nope"), { code: `rejected: ${TRANSCRIPT}` }),
    );

    expect(described).toBe("Error");
  });

  it("reduces a non-object throwable to its type, since its value may be the transcript", () => {
    expect(describeErrorForLog(TRANSCRIPT)).toBe("<string>");
    expect(describeErrorForLog(null)).toBe("<null>");
    expect(describeErrorForLog(undefined)).toBe("<undefined>");
  });

  it("names a throwable that lies about its own name by its constructor", () => {
    class ProviderRejection extends Error {}
    const rejection = new ProviderRejection("nope");
    rejection.name = `provider said ${TRANSCRIPT}`;

    expect(describeErrorForLog(rejection)).toBe("ProviderRejection");
  });
});
