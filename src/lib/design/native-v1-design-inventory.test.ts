import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

type NativeDesignInventory = {
  schema_version: number;
  redirect: {
    epic: string;
    authority_issue: string;
    photo_contract_issue: string;
    voice_contract_issue: string;
    swiftui_implementation_authorized_by_this_file: boolean;
  };
  lean_product_contract: {
    primary_destinations: string[];
    settings_entry: string;
    scan: {
      ordered_photo_count: { minimum: number; maximum: number };
      optional_voice_context: boolean;
      voice_duration_seconds_maximum: number;
      clears_after: string;
      processing: string;
    };
    seller_facing_progress: {
      states: string[];
      forbidden_terms: string[];
      fabricated_percentage_or_eta: boolean;
    };
    first_value: Record<string, unknown>;
    marketplace_authority: Record<string, unknown>;
    preserved_authority: string[];
  };
  retired_v1_package: Record<string, unknown>;
  retired_run_rev_delta: Record<string, unknown>;
  superseded_state_families: Array<Record<string, unknown>>;
  retired_state_ids_with_production_provenance: string[];
  retained_runtime_contracts: Array<{
    path: string;
    status: string;
    legacy_home_projection_is_navigation_authority: boolean;
    photo_maximum: { current: number; target: number; owner_issue: number };
    voice_context_owner_issue: number;
  }>;
  implementation_states: unknown[];
  seller_facing_copy_supersessions: Array<Record<string, unknown>>;
  package_claim_overrides: Array<Record<string, unknown>>;
  stop_rules: string[];
};

const inventoryPath = resolve("docs/design/native-v1-design-inventory.json");
const handoffPath = resolve("docs/design/native-v1-implementation-handoff.md");

function readInventory(): NativeDesignInventory {
  return JSON.parse(readFileSync(inventoryPath, "utf8")) as NativeDesignInventory;
}

describe("lean native design authority contract", () => {
  it("pins the Scan-to-Trophy-Wall product boundary", () => {
    const inventory = readInventory();

    expect(inventory.schema_version).toBe(2);
    expect(inventory.redirect).toEqual({
      epic: "https://github.com/azizu06/snaplist/issues/349",
      authority_issue: "https://github.com/azizu06/snaplist/issues/350",
      photo_contract_issue: "https://github.com/azizu06/snaplist/issues/352",
      voice_contract_issue: "https://github.com/azizu06/snaplist/issues/351",
      final_high_fidelity_design: "owned_by_redirected_design_task",
      swiftui_implementation_authorized_by_this_file: false,
    });
    expect(inventory.lean_product_contract).toMatchObject({
      primary_destinations: ["Scan", "Trophy Wall"],
      settings_entry: "profile_avatar",
      scan: {
        ordered_photo_count: { minimum: 1, maximum: 5 },
        optional_voice_context: true,
        voice_duration_seconds_maximum: 15,
        clears_after: "durable_server_acceptance",
        processing: "asynchronous",
      },
      first_value: {
        usable_listing_before_signup_or_paywall: true,
        complete_guest_ai_item_runs: 1,
        guided_identity_corrections: 1,
        guest_recovery_hours: 24,
        hard_paid_gate_at_complete_ai_item_run: 2,
      },
      marketplace_authority: {
        direct_publish_destination: "eBay",
        assisted_export_pack_destinations: [
          "Facebook Marketplace",
          "Mercari",
          "Depop",
        ],
        explicit_seller_confirmation_required: true,
        prepared_or_shared_means_published: false,
      },
    });
    expect(inventory.lean_product_contract.seller_facing_progress).toEqual({
      states: [
        "pending_upload",
        "accepted",
        "analyzing",
        "ready_to_review",
        "needs_retry",
        "published_to_ebay",
        "export_pack_prepared_or_shared",
      ],
      forbidden_terms: ["queue", "worker", "lease", "provider"],
      fabricated_percentage_or_eta: false,
    });
  });

  it("retains old package provenance without granting implementation authority", () => {
    const inventory = readInventory();

    expect(inventory.retired_v1_package).toMatchObject({
      sha256: "13ea5cfc237a98d188452b66abde94fb24b44e2e539ee63f42eb232120672415",
      status: "superseded_by_issue_349",
      historical_evidence_retained: true,
      authorizes_new_implementation: false,
    });
    expect(inventory.retired_run_rev_delta).toMatchObject({
      sha256: "93bb1571b2926c4c79744a8fe28905f972a7fda506a81765376b704dbb964884",
      status: "superseded_by_issue_349",
      historical_evidence_retained: true,
      authorizes_new_implementation: false,
    });
    expect(inventory.implementation_states).toEqual([]);
    expect(inventory.superseded_state_families.map((entry) => entry.family)).toEqual(
      expect.arrayContaining([
        "five_tab_navigation",
        "inbox_and_buyer_messaging",
        "generic_analytics_and_insights",
        "post_sale_operations",
        "bulk_haul_capture",
        "barcode_only_capture",
        "garment_measurements",
        "autonomous_marketplace_actions",
      ]),
    );
  });

  it("keeps the repository-normalized retired V1 archive integrity-verifiable", () => {
    const archiveRoot = resolve("ios/DesignContracts/Retired/V1-2026-07-16");
    const manifest = JSON.parse(
      readFileSync(resolve(archiveRoot, "ARCHIVE-MANIFEST.json"), "utf8"),
    ) as { files: Array<{ path: string; sha256: string }> };

    for (const file of manifest.files) {
      const retainedPath = resolve(archiveRoot, file.path);
      const digest = createHash("sha256")
        .update(readFileSync(retainedPath))
        .digest("hex");
      expect(digest, file.path).toBe(file.sha256);
    }
  });

  it("classifies retained runtime contracts as implementation gaps, not product authority", () => {
    const inventory = readInventory();

    expect(inventory.retained_runtime_contracts).toEqual([
      {
        path: "docs/contracts/mobile-api-v1.openapi.json",
        status: "current_runtime_contract_with_lean_mvp_gaps",
        legacy_home_projection_is_navigation_authority: false,
        photo_maximum: { current: 5, target: 5, owner_issue: 352 },
        voice_context_owner_issue: 351,
      },
      {
        path: "ios/DesignContracts/V1/mobile-api-v1.openapi.json",
        status: "mirrored_runtime_contract_with_lean_mvp_gaps",
        legacy_home_projection_is_navigation_authority: false,
        photo_maximum: { current: 5, target: 5, owner_issue: 352 },
        voice_context_owner_issue: 351,
      },
    ]);

    for (const retained of inventory.retained_runtime_contracts) {
      const contract = JSON.parse(readFileSync(resolve(retained.path), "utf8")) as {
        paths: Record<string, unknown>;
        components: {
          schemas: {
            MobileItemSubmissionReceipt: {
              properties: { photos: { maxItems: number } };
            };
          };
        };
        "x-snaplist-product-authority": Record<string, unknown>;
      };
      expect(contract.paths).toHaveProperty("/v1/home");
      expect(
        contract.components.schemas.MobileItemSubmissionReceipt.properties.photos
          .maxItems,
      ).toBe(retained.photo_maximum.current);
      expect(contract["x-snaplist-product-authority"]).toEqual({
        status: "retained_runtime_contract_with_lean_mvp_gaps",
        leanMvpAuthority: "PRD.md and ADR-0008",
        legacyHomeProjectionIsPrimaryNavigationAuthority: false,
        photoMaximumImplementationGap: {
          current: 4,
          target: 5,
          ownerIssue: 352,
        },
        voiceContextProductionGateOwnerIssue: 386,
      });
    }
  });

  it("governs the included-first-run allowance noun without reopening RUN-08", () => {
    const inventory = readInventory();

    expect(inventory.seller_facing_copy_supersessions).toEqual([
      {
        attribute: "seller_facing_noun_for_included_first_run_allowance",
        allowance_object: {
          table: "public.ai_item_allowance_periods",
          period_key: "included-first-run",
        },
        governed_by: {
          package: "snaplist-pro-gate-design-package-v1-2026-07-25",
          path: "/Users/aziz.u/Documents/Codex/2026-07-15/snaplist-ios-design-review/outputs/snaplist-pro-gate-design-package-v1-2026-07-25.zip",
          sha256:
            "baafa88bb48cdd4b2f0a485b72c55724376986dc0d39f9091b0b37456c2d1670",
          state_id: "PAY-01",
          noun: "AI listing",
          string: "You made one AI listing for free.",
        },
        supersedes: [
          {
            package:
              "snaplist-implementation-fidelity-delta-run-rev-v1.1-2026-07-16",
            path: "/Users/aziz.u/Documents/Codex/2026-07-15/snaplist-ios-design-review/outputs/snaplist-implementation-fidelity-delta-run-rev-v1.1-2026-07-16.zip",
            sha256:
              "93bb1571b2926c4c79744a8fe28905f972a7fda506a81765376b704dbb964884",
            state_id: "RUN-08",
            noun: "item",
            strings: [
              "Your first item is on us",
              "Item 1 will finish free. The rest stay staged and safe — you choose whether to continue them on SnapList Pro. Nothing starts or is discarded without you.",
            ],
          },
        ],
        scope: "attribute_only",
        reopens_superseded_package_states: false,
        sealed_packages_modified: false,
        rule: "New or revised seller-facing copy naming this allowance uses `AI listing`. `item` remains the seller's physical object. Every other RUN-08 attribute stays approved and in force; only the allowance noun is superseded, and the sealed packages stay byte-identical.",
        live_occurrences_of_superseded_noun: {
          note: "The superseded noun is not confined to sealed packages. It still ships in the working tree at the surfaces below. This record does not change them: seller-facing copy is owned by the active design round and its implementing issue, not by a documentation-authority change. Recorded so the supersession cannot be mistaken for already-reconciled product copy.",
          reconciled_by_this_record: false,
          surfaces_are_exhaustive_as_of: "2026-07-26",
          surfaces_exclude:
            "sealed design-contract archives under ios/DesignContracts, and this inventory and its own validator",
          surfaces: [
            {
              state_id: "ONB-06",
              path: "ios/SnapList/Features/Onboarding/OnboardingDomain.swift",
              symbol: "OnboardingCopy.allowanceTitle",
              rendered_at:
                "ios/SnapList/Features/Onboarding/OnboardingFlowView.swift",
              string: "Your first item is on us",
              has_retired_state_record: false,
            },
            {
              state_id: "HOME-02",
              path: "ios/SnapList/Features/Home/HomeViews.swift",
              string: "Your first item is on us — no account needed to try it.",
              has_retired_state_record: true,
            },
            {
              state_id: "HOME-02",
              path: "src/lib/scout-guidance/catalog.v1.json",
              keys: ["empty.home.body", "empty.home.accessibilityLabel"],
              string: "Your first item is on us — no account needed to try it.",
              has_retired_state_record: true,
            },
            {
              state_id: "HOME-02",
              path: "src/lib/scout-guidance/approved-copy-provenance.v1.json",
              string: "Your first item is on us — no account needed to try it.",
              has_retired_state_record: true,
              note: "Provenance record for the catalog entry above, not a separate render site.",
            },
            {
              state_id: "ONB-06",
              path: "ios/SnapListUITests/SnapListUITests.swift",
              string: "Your first item is on us",
              has_retired_state_record: false,
              note: "Test assertion pinning the current string. It fails when the copy is reconciled, which is the intended signal, not a defect.",
            },
          ],
        },
        third_noun_survey: {
          performed_on: "2026-07-26",
          scope:
            "all 87 packages under the design-review outputs directory, including the pre-redirect kit and fidelity-delta packages, plus the in-repo live copy surfaces under ios/SnapList and src/lib/scout-guidance",
          distinct_seller_facing_nouns_found: ["AI listing", "item"],
          third_noun_found: false,
          notes: [
            "No other currently approved lean-MVP family names this allowance at all. Scan Camera v2, Photo Review v1.2, Voice Note + Start Listing v2, Trophy Wall Processing v2, Listing Review v2, and Assisted Export v1 contain no allowance-naming seller-facing string.",
            "The pre-redirect kit and fidelity-delta packages (connected-marketplaces, ebay-publish, identity-guided-correction, net-proceeds-listing-draft, durable-runs-recovery, accountless-onboarding, account-claim-ebay-connect, capture-entry-guided-camera, seller-home) were included in the sweep and introduce no additional noun.",
            "`AI item` appears only inside families ADR-0008 already retired (bulk_haul_capture, barcode_only_capture, garment_measurements) and denotes the internal accounting unit, not a competing seller-facing noun.",
            "The retired Seller Home family already used `AI listing` (`One complete AI listing is free on this device.`), so the governing noun is continuous with prior approved copy rather than newly invented.",
            "The in-repo live surfaces carry the superseded `item` noun only. They add no third noun, and they are itemized under live_occurrences_of_superseded_noun.",
          ],
        },
      },
    ]);
  });

  it("denies implementation authority to the Pro Gate free-publish claim", () => {
    const inventory = readInventory();

    expect(inventory.package_claim_overrides).toEqual([
      {
        attribute: "first_item_free_end_to_end_including_first_ebay_publish",
        asserted_by: {
          package: "snaplist-pro-gate-design-package-v1-2026-07-25",
          path: "/Users/aziz.u/Documents/Codex/2026-07-15/snaplist-ios-design-review/outputs/snaplist-pro-gate-design-package-v1-2026-07-25.zip",
          sha256:
            "baafa88bb48cdd4b2f0a485b72c55724376986dc0d39f9091b0b37456c2d1670",
          file: "README-FIRST.md",
          claim:
            "The first item is free end to end, including its first eBay publish.",
        },
        classification: "product_intent_not_available_behavior",
        product_intent_authority:
          "docs/adr/0008-native-launch-entitlement-credits-and-ebay-authority.md",
        shipped_schema_state: {
          publish_entitlement_object_exists: false,
          entitlement_objects_present: [
            "public.ai_item_allowance_periods",
            "public.ai_item_credit_reservations",
            "public.revenuecat_customer_bindings",
          ],
          note: "Every shipped entitlement object grants AI item runs. No object grants, reserves, or settles an eBay publish, so an implementer has nothing to read a free-first-publish state from.",
        },
        must_not_implement_from: true,
        blocked_until:
          "a publish entitlement object exists in the shipped schema under its own approved issue",
        seller_facing_strings_affected: [],
        cross_reference: "https://github.com/azizu06/snaplist/issues/377",
        sealed_packages_modified: false,
        rule: "Treat the README sentence as intent only. Do not build a free-first-publish entitlement, gate, or seller-facing claim from it, and do not write later copy from it. The package's own seller-facing strings promise nothing about publish and are unaffected.",
      },
    ]);
  });

  it("keeps the canonical handoff explicit about retired launch concepts", () => {
    const canonicalText = [
      readFileSync(inventoryPath, "utf8"),
      readFileSync(handoffPath, "utf8"),
    ].join("\n");

    for (const requiredClaim of [
      /Scan/, /Trophy Wall/, /Settings/, /one to five/i, /fifteen seconds/i,
      /superseded/i, /no SwiftUI implementation authorization/i,
      /Inbox/i, /generic analytics/i, /post-sale/i, /bulk\/haul/i,
      /barcode-only/i, /garment measurements/i, /autonomous marketplace actions/i,
    ]) {
      expect(canonicalText, requiredClaim.source).toMatch(requiredClaim);
    }

    for (const forbiddenClaim of [
      /Seller Pro/i,
      /launch autopilot/i,
      /direct publish to (?:Mercari|Facebook Marketplace|Depop)/i,
      /(?:1A Ledger|magpie)/i,
    ]) {
      expect(canonicalText.match(forbiddenClaim), forbiddenClaim.source).toBeNull();
    }
  });
});
