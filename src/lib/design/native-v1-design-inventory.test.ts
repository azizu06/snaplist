import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type InventoryState = {
  id: string;
  status: string;
};

type NativeDesignInventory = {
  active_design_review: {
    task_id: string;
    status: string;
    live_project_mutation_authorized: boolean;
  };
  frozen_package: {
    path: string;
    sha256: string;
    approved_state_count: number;
  };
  approved_deltas: Array<{
    path: string;
    version: string;
    sha256: string;
    exact_base: string;
    internal_checksums_verified: boolean;
    approved_frame_ids: string[];
    candidate_unchanged: string[];
    withheld_unchanged: string[];
  }>;
  known_contract_conflicts: unknown[];
  implementation_epic: Record<string, string>;
  product_contract: Record<string, unknown>;
  visual_contract: Record<string, unknown>;
  states: InventoryState[];
};

const inventoryPath = resolve("docs/design/native-v1-design-inventory.json");
const handoffPath = resolve("docs/design/native-v1-implementation-handoff.md");

describe("native V1 design inventory contract", () => {
  it("keeps the frozen, candidate, withheld, and delta-gated state sets distinct", () => {
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as NativeDesignInventory;
    const stateIds = inventory.states.map((state) => state.id);
    const idsWithStatus = (status: string) =>
      inventory.states
        .filter((state) => state.status === status)
        .map((state) => state.id)
        .sort();

    expect(stateIds).toHaveLength(121);
    expect(new Set(stateIds).size).toBe(stateIds.length);

    expect(idsWithStatus("implementation_frozen")).toEqual(
      [
        "ONB-00",
        "ONB-01",
        "ONB-05",
        "ONB-06",
        "ONB-07",
        "native-camera-permission",
        "ONB-08",
        "settings-handoff",
        "ONB-09-camera",
        "ONB-09-library",
        "returning-sign-in",
        "CAP-01",
        "CAP-02a",
        "CAP-02b1",
        "CAP-02b2",
        "CAP-02c",
        "CAP-03-handoff",
        "S1",
        "S1b",
        "S2",
        "S3",
        "HOME-01",
        "HOME-02",
        "HOME-03",
        "HOME-04",
        "RUN-01",
        "RUN-02",
        "RUN-03",
        "RUN-04",
        "RUN-05",
        "RUN-06",
        "RUN-07",
        "RUN-08",
        "REV-01",
        "REV-02a",
        "REV-02b",
        "REV-02c",
        "REV-02d",
        "REV-02d-retry",
        "REV-02e",
        "REV-07",
        "REV-08",
      ].sort(),
    );
    expect(idsWithStatus("candidate_not_implementation_frozen")).toEqual(
      ["CAP-03a", "CAP-03b", "CAP-03c", "CAP-03d", "CAP-03e", "CAP-04"].sort(),
    );
    expect(idsWithStatus("withheld_interaction_repair")).toEqual(["CAP-05"]);
    expect(idsWithStatus("implementation_frozen_parent")).toEqual(["REV-02"]);
    expect(idsWithStatus("approved_awaiting_machine_readable_delta")).toEqual([]);
  });

  it("pins package provenance, product truth, visual exceptions, and implementation owners", () => {
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as NativeDesignInventory;

    expect(inventory.frozen_package).toMatchObject({
      path: "/Users/aziz.u/Documents/Codex/2026-07-15/snaplist-ios-design-review/outputs/snaplist-implementation-fidelity-package-v1-2026-07-16.zip",
      sha256: "13ea5cfc237a98d188452b66abde94fb24b44e2e539ee63f42eb232120672415",
      approved_state_count: 25,
    });
    expect(inventory.active_design_review).toEqual({
      task_id: "019f6900-23bc-7a23-a861-1cfa65753dc8",
      status: "design_only_active",
      live_project_mutation_authorized: false,
    });
    expect(inventory.approved_deltas).toEqual([
      {
        path: "/Users/aziz.u/Documents/Codex/2026-07-15/snaplist-ios-design-review/outputs/snaplist-implementation-fidelity-delta-run-rev-v1.1-2026-07-16.zip",
        version: "run-rev-delta-v1.1",
        sha256: "93bb1571b2926c4c79744a8fe28905f972a7fda506a81765376b704dbb964884",
        exact_base: "snaplist-implementation-fidelity-package-v1-2026-07-16.zip",
        internal_checksums_verified: true,
        approved_frame_ids: [
          "RUN-01",
          "RUN-02",
          "RUN-03",
          "RUN-04",
          "RUN-05",
          "RUN-06",
          "RUN-07",
          "RUN-08",
          "REV-01",
          "REV-02a",
          "REV-02b",
          "REV-02c",
          "REV-02d",
          "REV-02d-retry",
          "REV-02e",
          "REV-07",
          "REV-08",
        ],
        candidate_unchanged: ["CAP-03a", "CAP-03b", "CAP-03c", "CAP-03d", "CAP-03e", "CAP-04"],
        withheld_unchanged: ["CAP-05"],
      },
    ]);
    expect(inventory.known_contract_conflicts).toEqual([]);
    expect(inventory.implementation_epic).toEqual({
      epic: "https://github.com/azizu06/snaplist/issues/204",
      foundation: "https://github.com/azizu06/snaplist/issues/205",
      accountless_onboarding: "https://github.com/azizu06/snaplist/issues/206",
      capture: "https://github.com/azizu06/snaplist/issues/207",
      seller_home: "https://github.com/azizu06/snaplist/issues/208",
      pricing_evidence: "https://github.com/azizu06/snaplist/issues/209",
      durable_runs_recovery: "https://github.com/azizu06/snaplist/issues/211",
      identity_guided_correction: "https://github.com/azizu06/snaplist/issues/212",
    });
    expect(inventory.visual_contract).toMatchObject({
      direction: "White Seller Utility",
      action_blue: "#3665F3",
      pricing_source_blue: "#0031E9",
      pricing_source_blue_disposition: "visual_diff_only_use_action_blue_in_implementation",
      temporary_product_photography: { may_ship: false },
    });
    expect(inventory.product_contract).toMatchObject({
      first_value: {
        complete_guest_ai_item_runs: 1,
        guided_identity_corrections: 1,
        manual_edits: "unlimited_when_photo_set_fingerprint_is_unchanged",
      },
      snaplist_pro: {
        first_usable_listing_free: true,
        first_seller_confirmed_ebay_publish_free: true,
        hard_gate_at_complete_ai_item_run: 2,
        allowance_window: "configurable_monthly",
      },
      navigation: {
        primary: ["Home", "Listings", "Capture", "Inbox", "Insights"],
        runs_entry: "contextual_from_home",
        runs_is_primary_destination: false,
      },
      post_sale: {
        fulfilled_label: "shipped",
        fulfilled_is_carrier_delivered: false,
      },
      economics: {
        without_cost_show_profit: false,
      },
    });
  });

  it("rejects stale product and visual claims from the canonical handoff", () => {
    const canonicalText = [
      readFileSync(inventoryPath, "utf8"),
      readFileSync(handoffPath, "utf8"),
    ].join("\n");
    const forbiddenClaims = [
      /Seller Pro/i,
      /snaplist-implementation-fidelity-delta-run-rev-v1-2026-07-16\.zip/i,
      /d6468601ac3ad584caaf69b9bf27d64d1b5d2d8eb575f26576babed30e13e001/i,
      /\b\d+\s+items?\s+(?:per|a)\s+day\b/i,
      /capacity[- ]only/i,
      /Runs tab/i,
      /launch autopilot/i,
      /direct publish to (?:Mercari|Facebook Marketplace|Depop)/i,
      /FULFILLED[^\n.]{0,80}(?:means|is|as) (?:carrier-)?delivered/i,
      /(?:1A Ledger|magpie)/i,
    ];

    for (const forbiddenClaim of forbiddenClaims) {
      expect(canonicalText.match(forbiddenClaim), forbiddenClaim.source).toBeNull();
    }
  });
});
