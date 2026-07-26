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
      status: "complete",
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
      status: "complete",
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
      status: "complete",
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
      "user-settings",
      "ebay-drafts",
      "export-packs",
      "pipeline-runs",
      "pricing-evidence",
      "per-run-telemetry",
      "guest-recovery",
      "ai-item-credits",
      "mobile-ebay-oauth-session-state",
      "ebay-connections",
      "ebay-publish-receipts",
      "clerk-identity",
      "apple-revenuecat-references",
    ]);
  });

  it("defines one exact mobile eBay OAuth session/state disposition", () => {
    const matchingData = contract.data.filter(
      ({ id }) => id === "mobile-ebay-oauth-session-state",
    );

    expect(matchingData).toEqual([
      {
        id: "mobile-ebay-oauth-session-state",
        releaseDatum: true,
        dispositions: [
          {
            treatment: "delete",
            owner: "seller-snaplist-tenant",
            deletionTriggers: [
              "oauth-session-terminal",
              "oauth-session-expires",
              "account-erasure",
            ],
            maximumRetention:
              "active unexpired rows are ineligible; delete no later than 24 hours after the row first becomes terminal or reaches the database-authoritative expires_at; account erasure removes every owned row immediately regardless of status",
            executor:
              "snaplist-mobile-ebay-oauth-retention-capability-and-issue-384-account-erasure-capability",
            completionProof:
              "bounded cleanup reports no eligible owned row and durable absence is confirmed; account erasure reports no mobile eBay OAuth session row for the tenant",
          },
        ],
      },
    ]);
  });

  it("rejects an omitted mobile eBay OAuth session/state disposition", () => {
    const invalid = structuredClone(contract);
    invalid.data = invalid.data.filter(
      ({ id }) => id !== "mobile-ebay-oauth-session-state",
    );

    expect(() => parseReleaseRetentionContract(invalid)).toThrow(
      /exactly one mobile eBay OAuth session\/state disposition/i,
    );
  });

  it("rejects duplicate mobile eBay OAuth session/state dispositions", () => {
    const invalid = structuredClone(contract);
    const mobileOauth = invalid.data.find(
      ({ id }) => id === "mobile-ebay-oauth-session-state",
    );
    if (!mobileOauth) throw new Error("Mobile eBay OAuth disposition is missing");
    invalid.data.push(structuredClone(mobileOauth));

    expect(() => parseReleaseRetentionContract(invalid)).toThrow(
      /exactly one mobile eBay OAuth session\/state disposition/i,
    );
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

  // A guest's artifacts leave by exactly two shipped paths. #175 defines both
  // `guestRecoveryTerminalOutcomeSchema` and `guestClaimTerminalOutcomeSchema`
  // in src/lib/guest-recovery/service.ts as two-member unions — claimed or
  // expired — and ships no seller-initiated discard before claim. A trigger
  // this row names that nothing can fire is a deletion promise the product
  // cannot honour, so the row is pinned to the outcomes that exist.
  it("names only the guest deletion triggers the shipped claim-or-expiry seam can fire", () => {
    const guestRecovery = contract.data.find(({ id }) => id === "guest-recovery");

    expect(guestRecovery?.dispositions[0].deletionTriggers).toEqual([
      "successful-claim-transfers-ownership",
      "guest-recovery-expires",
    ]);
  });

  it("gives every release datum a resolved disposition, with no blocked row left", () => {
    const blocked = contract.data.filter(
      ({ dispositions }) => dispositions[0].treatment === "blocked",
    );

    expect(blocked.map(({ id }) => id)).toEqual([]);
    expect(contract.blockers).toEqual([]);
  });

  it("cites the published provider authority behind every resolved provider obligation", () => {
    const providerObligations = [
      "hosted-transcription-provider-copy",
      "ebay-publish-receipts",
      "clerk-identity",
      "apple-revenuecat-references",
    ];

    for (const id of providerObligations) {
      const disposition = contract.data.find(
        (datum) => datum.id === id,
      )?.dispositions[0];

      expect(disposition?.citations?.length ?? 0).toBeGreaterThan(0);
      for (const citation of disposition?.citations ?? []) {
        expect(citation.url).toMatch(/^https:\/\//);
        expect(citation.clause.length).toBeGreaterThan(0);
        expect(citation.quote.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects a contract that drops a provider obligation entirely", () => {
    const invalid = structuredClone(contract);
    invalid.data = invalid.data.filter(({ id }) => id !== "clerk-identity");

    expect(() => parseReleaseRetentionContract(invalid)).toThrow(
      /provider obligation cannot be dropped/i,
    );
  });

  it("rejects a resolved provider obligation with no cited authority", () => {
    const invalid = structuredClone(contract);
    const clerk = invalid.data.find(({ id }) => id === "clerk-identity");
    if (!clerk) throw new Error("Clerk identity release datum is missing");
    delete clerk.dispositions[0].citations;

    expect(() => parseReleaseRetentionContract(invalid)).toThrow(
      /must cite the published provider authority/i,
    );
  });

  it("rejects a complete contract that still carries a blocked disposition", () => {
    const invalid = structuredClone(contract);
    const clerk = invalid.data.find(({ id }) => id === "clerk-identity");
    if (!clerk) throw new Error("Clerk identity release datum is missing");
    clerk.dispositions[0].treatment = "blocked";

    expect(() => parseReleaseRetentionContract(invalid)).toThrow(
      /complete contract cannot carry a blocked disposition/i,
    );
  });

  it("rejects a release-blocked contract with nothing blocking it", () => {
    const invalid = structuredClone(contract);
    invalid.status = "release-blocked";

    expect(() => parseReleaseRetentionContract(invalid)).toThrow(
      /must identify the blocked disposition holding it back/i,
    );
  });

  it("rejects blocked dispositions without a matching blocker record", () => {
    const invalid = structuredClone(contract);
    invalid.status = "release-blocked";
    const clerk = invalid.data.find(({ id }) => id === "clerk-identity");
    if (!clerk) throw new Error("Clerk identity release datum is missing");
    clerk.dispositions[0].treatment = "blocked";
    clerk.dispositions[0].blockerId = "clerk-identity-retention";
    invalid.blockers = [];

    expect(() => parseReleaseRetentionContract(invalid)).toThrow(
      /must reference a matching blocker record/i,
    );
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

  // The contract is normative, but ADR-0012 is what a reader reaches for
  // first. Prose that still describes a gate as open once the row records it
  // closed sends that reader the wrong way, so the two are held together.
  it("describes the Clerk absence proof as observed, matching the clerk-identity row", () => {
    const adr = readFileSync(
      resolve("docs/adr/0012-lean-mvp-retention-and-deletion-matrix.md"),
      "utf8",
    );
    const clerk = contract.data.find(({ id }) => id === "clerk-identity");

    expect(clerk?.dispositions[0].completionProof).toContain("OBSERVED 2026-07-26");
    expect(adr).not.toMatch(
      /has not yet been observed|records an unobserved proof|until the test has actually run|defined but not yet performed/,
    );
    expect(adr).toMatch(
      /observed on 2026-07-26 against a live Clerk development instance/,
    );
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
