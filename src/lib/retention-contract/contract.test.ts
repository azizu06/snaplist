import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseReleaseRetentionContract } from "./contract";

const contract = parseReleaseRetentionContract(
  JSON.parse(
    readFileSync(
      resolve("docs/contracts/lean-mvp-retention-v1.json"),
      "utf8",
    ),
  ),
);

const completeDisposition = {
  treatment: "delete",
  owner: "seller-local-client",
  deletionTriggers: ["local-recovery-window-expires"],
  maximumRetention: "24 hours from local intake capture",
  executor: "native-intake-cleanup-capability",
  completionProof: "protected local file is absent",
};

describe("lean-MVP release retention contract", () => {
  it("rejects a release datum without one complete disposition", () => {
    const datumWithoutDisposition = {
      contract: "snaplist.lean-mvp-retention",
      version: 1,
      status: "release-blocked",
      ownerIssue: 383,
      data: [
        {
          id: "local-photos",
          releaseDatum: true,
        },
      ],
      blockers: [],
    };

    expect(() =>
      parseReleaseRetentionContract(datumWithoutDisposition),
    ).toThrow();
  });

  it("rejects a release datum with more than one disposition", () => {
    const datumWithTwoDispositions = {
      contract: "snaplist.lean-mvp-retention",
      version: 1,
      status: "release-blocked",
      ownerIssue: 383,
      data: [
        {
          id: "local-photos",
          releaseDatum: true,
          dispositions: [completeDisposition, completeDisposition],
        },
      ],
      blockers: [],
    };

    expect(() =>
      parseReleaseRetentionContract(datumWithTwoDispositions),
    ).toThrow();
  });

  it("rejects a release datum with an incomplete disposition", () => {
    const datumWithIncompleteDisposition = {
      contract: "snaplist.lean-mvp-retention",
      version: 1,
      status: "release-blocked",
      ownerIssue: 383,
      data: [
        {
          id: "local-photos",
          releaseDatum: true,
          dispositions: [
            {
              treatment: "delete",
              owner: "seller-local-client",
              deletionTriggers: ["local-recovery-window-expires"],
              maximumRetention: "24 hours from local intake capture",
              executor: "native-intake-cleanup-capability",
            },
          ],
        },
      ],
      blockers: [],
    };

    expect(() =>
      parseReleaseRetentionContract(datumWithIncompleteDisposition),
    ).toThrow();
  });

  it("covers every lean-MVP release datum", () => {
    expect(contract.data.map(({ id }) => id)).toEqual([
      "local-intake-photos",
      "local-intake-voice",
      "private-storage-photos",
      "private-storage-raw-voice",
      "hosted-transcription-provider-copy",
      "seller-voice-transcript",
      "items",
      "ebay-drafts",
      "export-packs",
      "pipeline-runs",
      "pricing-evidence",
      "per-run-telemetry",
      "guest-recovery",
      "ai-item-credits",
      "ebay-connections",
      "ebay-publish-receipts",
      "clerk-identity",
      "apple-revenuecat-references",
    ]);
  });

  it("rejects raw seller voice retained beyond 24 hours", () => {
    const invalid = structuredClone(contract);
    const rawVoice = invalid.data.find(
      ({ id }) => id === "private-storage-raw-voice",
    );
    if (!rawVoice) throw new Error("Raw voice release datum is missing");
    rawVoice.dispositions[0].maximumRetention =
      "25 hours after durable server acceptance";

    expect(() => parseReleaseRetentionContract(invalid)).toThrow();
  });

  it("requires raw seller voice deletion after terminal transcription", () => {
    const invalid = structuredClone(contract);
    const rawVoice = invalid.data.find(
      ({ id }) => id === "private-storage-raw-voice",
    );
    if (!rawVoice) throw new Error("Raw voice release datum is missing");
    rawVoice.dispositions[0].deletionTriggers = ["account-erasure"];

    expect(() => parseReleaseRetentionContract(invalid)).toThrow();
  });

  it("keeps every unresolved legal or provider obligation as an explicit blocker", () => {
    expect(contract.blockers).toEqual([
      {
        id: "hosted-transcription-retention",
        affectedData: ["hosted-transcription-provider-copy"],
        requiredEvidence:
          "current provider retention policy and approved zero-retention control evidence before activation",
      },
      {
        id: "ebay-publish-receipt-obligations",
        affectedData: ["ebay-publish-receipts"],
        requiredEvidence:
          "approved legal and eBay rule for SnapList publish receipts, external records, retention duration, and deletion proof",
      },
      {
        id: "clerk-identity-retention",
        affectedData: ["clerk-identity"],
        requiredEvidence:
          "current Clerk account deletion behavior, retention policy, and deletion proof",
      },
      {
        id: "apple-revenuecat-reference-obligations",
        affectedData: ["apple-revenuecat-references"],
        requiredEvidence:
          "approved Apple, RevenueCat, refund, tax, and legal rule with duration and provider-side proof",
      },
    ]);
  });

  it("rejects blocked dispositions without a matching blocker record", () => {
    const invalid = structuredClone(contract);
    invalid.blockers = [];

    expect(() => parseReleaseRetentionContract(invalid)).toThrow();
  });

  it("links the singular authoritative matrix from the PRD and retention ADR", () => {
    const contractPath = "docs/contracts/lean-mvp-retention-v1.json";
    const prd = readFileSync(resolve("PRD.md"), "utf8");
    const adr = readFileSync(
      resolve("docs/adr/0012-lean-mvp-retention-and-deletion-matrix.md"),
      "utf8",
    );

    expect(prd).toMatch(
      /`docs\/contracts\/lean-mvp-retention-v1\.json` is the singular row-level authority[\s\S]*owner, deletion triggers, maximum retention, executor, and completion proof/,
    );
    expect(adr).toMatch(
      /`docs\/contracts\/lean-mvp-retention-v1\.json` is the only normative row-level retention authority/,
    );
    expect(prd).toContain(contractPath);
    expect(adr).toContain(contractPath);
  });

  it("routes lean-MVP and voice retention authority to ADR-0012", () => {
    const leanMvpAdr = readFileSync(
      resolve("docs/adr/0008-native-launch-entitlement-credits-and-ebay-authority.md"),
      "utf8",
    );
    const voiceAdr = readFileSync(
      resolve("docs/adr/0011-optional-short-seller-voice-context.md"),
      "utf8",
    );

    expect(leanMvpAdr).toMatch(
      /ADR-0012 and `docs\/contracts\/lean-mvp-retention-v1\.json` are the singular\s+row-level authority for those deletion and retention dispositions/,
    );
    expect(voiceAdr).toMatch(
      /ADR-0012 and `docs\/contracts\/lean-mvp-retention-v1\.json` own the singular release matrix and\s+completion-proof vocabulary/,
    );
  });
});
