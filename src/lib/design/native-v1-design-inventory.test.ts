import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  implementation_states: unknown[];
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
