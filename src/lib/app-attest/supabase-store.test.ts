import { describe, expect, it, vi } from "vitest";
import { createSupabaseAppAttestStore } from "./supabase-store";

describe("Supabase App Attest store", () => {
  it("maps only the five narrow private-state RPCs", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: "\\x66697865642d6368616c6c656e6765", error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({
        data: [
          {
            app_id: "TEAMID1234.dev.snaplist.ios",
            assertion_counter: 0,
            attested_at: "2026-07-20T20:00:00.000Z",
            bundle_version: "1",
            environment: "production",
            key_id: "fixed-key",
            public_key_pem: "-----BEGIN PUBLIC KEY-----fixed",
            receipt: "\\x72656365697074",
            validation_category: 4,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });
    const store = createSupabaseAppAttestStore({ rpc });
    const now = new Date("2026-07-20T20:00:00.000Z");

    await store.issueChallenge({
      challenge: Buffer.from("fixed-challenge"),
      challengeId: "00000000-0000-4000-8000-000000000331",
      consumedAt: null,
      environment: "production",
      expiresAt: new Date("2026-07-20T20:05:00.000Z"),
      keyId: null,
      kind: "attestation",
    });
    await expect(
      store.claimChallenge({
        challengeId: "00000000-0000-4000-8000-000000000331",
        environment: "production",
        keyId: null,
        kind: "attestation",
        now,
      }),
    ).resolves.toMatchObject({
      challenge: Buffer.from("fixed-challenge"),
      consumedAt: now,
    });
    await expect(
      store.commitAttestation({
        evidence: {
          appId: "TEAMID1234.dev.snaplist.ios",
          bundleVersion: "1",
          counter: 0,
          environment: "production",
          keyId: "fixed-key",
          publicKey: "-----BEGIN PUBLIC KEY-----fixed",
          receipt: Buffer.from("receipt").toString("base64"),
          validationCategory: 4,
        },
        now,
      }),
    ).resolves.toBe(true);
    await expect(store.readAttestedKey("fixed-key")).resolves.toMatchObject({
      counter: 0,
      keyId: "fixed-key",
      receipt: Buffer.from("receipt").toString("base64"),
    });
    await expect(
      store.commitAssertion({
        evidence: {
          appId: "TEAMID1234.dev.snaplist.ios",
          bundleVersion: "1",
          counter: 1,
          environment: "production",
          keyId: "fixed-key",
          requestHash: "request-hash",
          validationCategory: 4,
        },
        now,
      }),
    ).resolves.toBe(true);

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "issue_app_attest_challenge",
      "claim_app_attest_challenge",
      "commit_app_attest_attestation",
      "read_app_attest_key",
      "commit_app_attest_assertion",
    ]);
  });
});
