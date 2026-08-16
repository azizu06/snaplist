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
      "ebay-photo-access-tokens",
      "private-storage-raw-voice",
      "hosted-transcription-provider-copy",
      "seller-voice-transcript",
      "items",
      "user-settings",
      "activation-guidance-completion",
      "device-tokens",
      "ebay-drafts",
      "export-packs",
      "pipeline-runs",
      "pricing-evidence",
      "per-run-telemetry",
      "posthog-analytics-person-and-events",
      "guest-recovery",
      "guest-claim-handoffs",
      "app-attest-challenges",
      "app-attest-current-keys",
      "ai-item-credits",
      "included-offer-device-claims",
      "included-offer-support-overrides",
      "included-offer-apple-device-bit",
      "mobile-ebay-oauth-session-state",
      "ebay-connections",
      "ebay-publish-receipts",
      // #711's post-publish sync copies. They carry the same eBay-issued
      // listing id as the receipts row and reach the same triggers, but the
      // matrix is row-level authority: a datum named only inside another row's
      // completion proof has no owner, ceiling, or executor a reader can find.
      "ebay-listing-sync-state",
      "ebay-listing-sync-conflicts",
      "clerk-identity",
      "apple-revenuecat-references",
      "account-erasure-receipt",
      "waitlist-email",
    ]);
  });

  // Account erasure cannot claim completion while a datum has no disposition,
  // and #711 landed two tenant tables holding the eBay-issued listing id plus
  // the seller's recorded price and status divergences against it. Both are
  // purged by the listing cascade at item deletion and by an explicit erasure
  // trigger; the matrix has to say so in its own rows, not only inside the
  // ebay-publish-receipts completion proof.
  it("binds both eBay sync copies to item deletion and account erasure", () => {
    for (const id of ["ebay-listing-sync-state", "ebay-listing-sync-conflicts"]) {
      const disposition = contract.data.find((datum) => datum.id === id)
        ?.dispositions[0];

      expect(disposition?.treatment).toBe("delete");
      expect(disposition?.owner).toBe("seller-snaplist-tenant");
      expect(disposition?.deletionTriggers).toContain("item-deletion");
      expect(disposition?.deletionTriggers).toContain("account-erasure");
      // The proof names the mechanism that actually removes the row, so a
      // migration that re-points the foreign key falsifies the row rather than
      // quietly outliving it.
      expect(disposition?.completionProof).toContain("on delete cascade");
      expect(disposition?.completionProof).toContain(
        "private.account_erasure_owned_row_count",
      );
    }
  });

  it("defines the activation guidance completion deletion disposition", () => {
    const completion = contract.data.find(
      ({ id }) => id === "activation-guidance-completion",
    );

    expect(completion).toEqual({
      id: "activation-guidance-completion",
      releaseDatum: true,
      dispositions: [
        {
          treatment: "delete",
          owner: "seller-snaplist-tenant",
          deletionTriggers: ["account-erasure"],
          maximumRetention:
            "for the account lifetime; deleted synchronously when account erasure begins",
          executor:
            "snaplist-account-erasure-activation-guidance-completion-trigger",
          completionProof:
            "the tenant activation_guidance_completions row is absent and the exhaustive account-erasure owned-row count includes the table",
        },
      ],
    });
  });

  // A device token is the address of a specific phone. Erasure that left one
  // behind would keep a deleted account reachable, so the row has to name the
  // trigger that removes it and the counter that proves it is gone — and it has
  // to survive the one identity change SnapList performs, guest to member,
  // without becoming an orphan nothing will ever delete.
  it("defines the push device token deletion disposition", () => {
    const devices = contract.data.find(({ id }) => id === "device-tokens");

    expect(devices).toEqual({
      id: "device-tokens",
      releaseDatum: true,
      dispositions: [
        {
          treatment: "delete",
          owner: "seller-snaplist-tenant",
          deletionTriggers: ["account-erasure"],
          maximumRetention:
            "for the account lifetime; a claimed guest's row is re-keyed to the claiming account rather than orphaned, and every row is deleted synchronously when account erasure begins",
          executor: "snaplist-account-erasure-device-token-trigger",
          completionProof:
            "the tenant device_tokens rows are absent and private.account_erasure_owned_row_count includes the table",
          ownerDecision:
            "Issue #890 stores only the APNs token, platform, owning Clerk subject, and last-seen timestamp. The row is keyed on (user_id, platform, token), so a device shared by two sellers is two independently owned rows and neither account can be re-keyed onto the other; the one legitimate re-key runs inside the guest-claim trigger, which learns both identities from the recovery record rather than from a caller.",
        },
      ],
    });
  });

  it("defines one bounded waitlist-email disposition", () => {
    const matchingData = contract.data.filter(({ id }) => id === "waitlist-email");

    expect(matchingData).toEqual([
      {
        id: "waitlist-email",
        releaseDatum: true,
        dispositions: [
          {
            treatment: "delete",
            owner: "snaplist-platform",
            deletionTriggers: [
              "waitlist-withdrawal",
              "one-time-launch-email-completes",
              "signup-reaches-24-month-ceiling",
            ],
            maximumRetention:
              "24 months after signup, or 30 days after the one-time launch email is sent, whichever is earlier; a withdrawal request deletes the row sooner",
            executor: "snaplist-operator-direct-sql-export-and-delete",
            completionProof:
              "a direct SQL count proves the normalized address is absent after withdrawal or the age ceiling; after launch, a full-table SQL count proves no waitlist row remains",
            ownerDecision:
              "Issue #620 collects the address only for one launch email. The 24-month ceiling bounds a launch delay without adding a sender, provider, or admin surface to this issue.",
          },
        ],
      },
    ]);
  });

  it("defines the PostHog analytics deletion disposition", () => {
    const analytics = contract.data.find(
      ({ id }) => id === "posthog-analytics-person-and-events",
    );

    expect(analytics).toEqual({
      id: "posthog-analytics-person-and-events",
      releaseDatum: true,
      dispositions: [
        {
          treatment: "delete",
          owner: "posthog-analytics-provider",
          deletionTriggers: ["account-erasure"],
          maximumRetention:
            "no later than account-erasure completion; SnapList keeps the erasure incomplete while PostHog person or queued historical-event deletion remains unverified",
          executor:
            "snaplist-account-erasure-posthog-person-and-events-deletion-capability",
          completionProof:
            "the executor records posthog_person_and_events_deletion_proved_at on the erasure receipt only after the PostHog person read-back reports absence and the deletion-status endpoint reports completed with delete_verified_at for that person UUID; a distinct-ID lookup reporting no person is absence proof when no deletion target was previously recorded",
          citations: [
            {
              url: "https://posthog.com/docs/api/persons",
              clause: "Create persons bulk delete",
              quote: "Only events captured before the request will be deleted.",
              retrieved: "2026-08-02",
            },
            {
              url: "https://posthog.com/docs/api/persons",
              clause: "List all persons deletion status",
              quote:
                "Use this endpoint to check whether those deletions are still pending or have been completed.",
              retrieved: "2026-08-02",
            },
          ],
          ownerDecision:
            "Issue #617 selects real deletion with delete_events=true, delete_recordings=false, and keep_person=false. SnapList session replay is disabled, so no recording datum exists to delete. Before a successful $identify merge, the anonymous distinct ID may label events in PostHog, but SnapList's server neither receives nor persists it and PostHog has no Clerk-ID association by which account erasure can discover it. If $identify reaches PostHog, it associates that anonymous ID with the Clerk-keyed person and deleting the recorded person UUID covers both distinct IDs; if it never reaches PostHog, the later Clerk-ID erasure cannot reach that unlinked anonymous person.",
        },
      ],
    });
  });

  // Account erasure keeps exactly one row after the account is gone, so the
  // matrix has to say so. The risk it carries is not the retention but the
  // identifiers: a receipt that outlived an account while still holding the
  // Clerk id would be the erasure quietly failing at its own promise.
  it("holds the erasure receipt to a scrubbed, bounded, self-pruned disposition", () => {
    const receipt = contract.data.find(({ id }) => id === "account-erasure-receipt");
    const disposition = receipt?.dispositions[0];

    expect(disposition?.treatment).toBe("delete");
    expect(disposition?.owner).toBe("snaplist-platform");
    expect(disposition?.maximumRetention).toMatch(/^30 days after the erasure reaches a completed status/);
    expect(disposition?.maximumRetention).toMatch(
      /raw Clerk user id, RevenueCat app user ids, SnapList user id, and Idempotency-Key are removed at the moment a completed status is written/,
    );

    // The row promised a scrub the code does not perform for an erasure that is
    // still unfinished — `deletion_needs_attention` keeps the raw identifiers
    // because resuming needs them. Say that, rather than let the matrix claim a
    // guarantee one of the five states does not honour.
    expect(disposition?.maximumRetention).toMatch(
      /still unfinished, including one parked in deletion_needs_attention, keeps those identifiers/,
    );

    // The named executor must be a job that actually exists and actually runs,
    // or the completion proof is a sentence rather than a proof.
    const migration = readFileSync(
      resolve("supabase/migrations/20260801120000_durable_account_erasure.sql"),
      "utf8",
    );
    expect(migration).toContain("private.prune_account_erasure_receipts");
    expect(migration).toContain("snaplist-account-erasure-receipt-retention-daily");
    expect(migration).toMatch(/interval '30 days'/);
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

  it("defines exact App Attest challenge and current-key retention dispositions", () => {
    const appAttestData = contract.data.filter(({ id }) =>
      ["app-attest-challenges", "app-attest-current-keys"].includes(id),
    );

    expect(appAttestData).toEqual([
      {
        id: "app-attest-challenges",
        releaseDatum: true,
        dispositions: [
          {
            treatment: "delete",
            owner: "guest-device-attestation",
            deletionTriggers: [
              "challenge-consumed",
              "challenge-expires",
              "account-or-guest-erasure",
            ],
            maximumRetention:
              "active unexpired rows are ineligible; delete no later than 24 hours after consumed_at or expires_at, whichever first makes the row eligible",
            executor:
              "private-hourly-app-attest-retention-and-immediate-erasure-capability",
            completionProof:
              "the private cleanup result and durable absence prove no eligible challenge row remains; cron.job registration and cron.job_run_details prove at least one successful cleanup in every rolling 24 hours",
            ownerDecision:
              "Aziz approved this challenge ceiling and executor for issue #331 on 2026-07-26. SnapList retains no challenge history.",
          },
        ],
      },
      {
        id: "app-attest-current-keys",
        releaseDatum: true,
        dispositions: [
          {
            treatment: "delete",
            owner: "guest-device-attestation",
            deletionTriggers: [
              "key-inactive-for-90-days",
              "account-or-guest-erasure",
            ],
            maximumRetention:
              "retain only the current key state while used; delete 90 days after latest successful assertion, or 90 days after attestation for a never-successful key",
            executor:
              "private-hourly-app-attest-retention-and-immediate-erasure-capability",
            completionProof:
              "the private cleanup result and durable absence prove no inactive key row remains; cron.job registration and cron.job_run_details prove at least one successful cleanup in every rolling 24 hours",
            ownerDecision:
              "Aziz approved this inactivity ceiling for issue #331 on 2026-07-26. Store only the current key ID, public key, required current receipt, counter, environment, attestation time, and latest successful verification time; retain no raw device fingerprint, historical receipt, or superseded key history.",
          },
        ],
      },
    ]);
  });

  it("defines the short-lived guest claim handoff disposition", () => {
    expect(
      contract.data.find(({ id }) => id === "guest-claim-handoffs"),
    ).toEqual({
      id: "guest-claim-handoffs",
      releaseDatum: true,
      dispositions: [{
        treatment: "delete",
        owner: "guest-device-attestation",
        deletionTriggers: [
          "handoff-consumed",
          "handoff-expires",
          "guest-recovery-deleted",
          "app-attest-key-deleted",
        ],
        maximumRetention:
          "active only for the configured 60-to-600-second TTL; atomically deleted on consume, otherwise no later than one hour after expires_at",
        executor:
          "atomic-guest-handoff-consume-and-private-hourly-retention-capability",
        completionProof:
          "successful verification returns the bound guest identity only from the atomic delete; the private health view proves durable absence of every expired row, exact active hourly registration, and a successful cron.job_run_details entry no older than one hour",
        ownerDecision:
          "Issue #610 stores only a handoff-token digest, recovery-token hash, App Attest key ID, guest/recovery IDs, App ID/environment, and immutable photo-set fingerprint. Raw handoff tokens, raw recovery tokens, assertions, and attestation objects are never retained.",
      }],
    });
  });

  it("rejects omitted or duplicate App Attest retention dispositions", () => {
    const omitted = structuredClone(contract);
    omitted.data = omitted.data.filter(
      ({ id }) => id !== "app-attest-challenges",
    );
    expect(() => parseReleaseRetentionContract(omitted)).toThrow(
      /exactly one App Attest challenge disposition/i,
    );

    const duplicated = structuredClone(contract);
    const currentKeys = duplicated.data.find(
      ({ id }) => id === "app-attest-current-keys",
    );
    if (!currentKeys) throw new Error("App Attest current-key row is missing");
    duplicated.data.push(structuredClone(currentKeys));
    expect(() => parseReleaseRetentionContract(duplicated)).toThrow(
      /exactly one App Attest current-key disposition/i,
    );
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
      "posthog-analytics-person-and-events",
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

  it("rejects PostHog analytics deletion without current provider authority", () => {
    const invalid = structuredClone(contract);
    const analytics = invalid.data.find(
      ({ id }) => id === "posthog-analytics-person-and-events",
    );
    if (!analytics) throw new Error("PostHog analytics disposition is missing");
    delete analytics.dispositions[0].citations;

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

  // The skip warning is the sentence a developer sees most often, since the
  // suite skips by default. It described the same closed gate as open.
  it("does not describe the Clerk proof as unobserved where the suite skips", () => {
    const absenceTest = readFileSync(
      resolve("src/lib/retention-contract/clerk-identity-absence.test.ts"),
      "utf8",
    );

    expect(absenceTest).not.toMatch(/not yet observed/);
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
