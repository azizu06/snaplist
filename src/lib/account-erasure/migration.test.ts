import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260722210000_durable_account_erasure.sql",
  "utf8",
);

const fencedTenantTables = [
  "public.items",
  "public.listings",
  "public.messages",
  "public.embeddings",
  "public.prediction_logs",
  "public.user_settings",
  "public.ebay_connections",
  "public.subscriptions",
  "public.notifications",
  "public.reprice_suggestions",
  "public.ebay_message_sync_state",
  "public.ebay_unresolved_questions",
  "public.message_policy_decisions",
  "public.message_attachments",
  "public.billing_customers",
  "public.billing_checkout_reservations",
  "public.ai_item_allowance_periods",
  "public.ai_item_credit_reservations",
  "public.revenuecat_customer_bindings",
  "public.pipeline_runs",
  "public.pricing_evidence_snapshots",
  "public.ebay_oauth_sessions",
  "private.ebay_messaging_account_generations",
  "private.ebay_seller_account_generations",
  "private.ebay_provider_dispatch_leases",
  "private.ebay_buyer_identity_provenance",
  "private.ebay_buyer_identity_observations",
  "private.ebay_erased_buyer_generation_tombstones",
  "private.ebay_sandbox_fallback_bindings",
  "private.ebay_unmappable_connection_quarantines",
  "private.ebay_seller_identity_tenants",
  "private.pipeline_run_usage_reservations",
  "private.pipeline_staging_cleanup_intents",
  "private.legacy_pipeline_usage_reservations",
  "private.mobile_item_submissions",
  "private.mobile_run_operation_replays",
  "private.guided_correction_completion_capabilities",
  "private.storekit_ai_item_period_events",
  "private.revenuecat_webhook_events",
  "private.guest_draft_recoveries",
  "private.pipeline_storage_cleanup_jobs",
  "private.message_photo_object_deletion_queue",
] as const;

describe("durable account erasure migration contract", () => {
  it("keeps one private generation and manifest behind service-only fixed RPCs", () => {
    expect(migration).toMatch(/create table private\.account_erasure_generations/i);
    expect(migration).toMatch(/user_id text not null unique/i);
    expect(migration).toMatch(/unique \(user_id, idempotency_key\)/i);
    expect(migration).toMatch(/create table private\.account_erasure_storage_manifest/i);
    expect(migration).toMatch(/alter table private\.account_erasure_generations force row level security/i);
    expect(migration).toMatch(/alter table private\.account_erasure_storage_manifest force row level security/i);
    for (const rpc of [
      "begin_account_erasure(text, uuid)",
      "confirm_account_erasure_storage_absence(uuid, text, text)",
      "advance_account_erasure(uuid, text[])",
    ]) {
      expect(migration).toContain(`revoke all on function public.${rpc}`);
      expect(migration).toContain(`grant execute on function public.${rpc}`);
    }
    expect(migration).not.toMatch(/grant (select|insert|update|delete|all).*account_erasure_/i);
  });

  it("serializes every current tenant root and both private Storage buckets", () => {
    for (const table of fencedTenantTables) {
      expect(migration).toContain(`'${table}'::regclass`);
    }
    const triggerCatalog = migration.match(
      /foreach v_table in array array\[([\s\S]*?)\] loop/i,
    )?.[1];
    expect(triggerCatalog).toBeDefined();
    const catalogTables = [...(triggerCatalog ?? "").matchAll(/'([^']+)'::regclass/g)]
      .map((match) => match[1]);
    expect(catalogTables).toEqual([...fencedTenantTables]);
    expect(new Set(catalogTables).size).toBe(catalogTables.length);
    expect(migration).toMatch(
      /create trigger fence_account_erasure_storage_object[\s\S]*before insert or update or delete on storage\.objects/i,
    );
    expect(migration).toMatch(/'account-erasure:' \|\| p_user_id/i);
    expect(migration).toMatch(/object\.bucket_id in \('photos', 'message-photos'\)/i);
  });

  it("blocks erasure before creating a generation when a guest claim is already copying", () => {
    const beginFunction = migration.match(
      /create function public\.begin_account_erasure\([\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(beginFunction).toBeDefined();
    expect(beginFunction).toMatch(
      /private\.lock_account_erasure\(p_user_id\)[\s\S]*private\.guest_draft_recoveries[\s\S]*claim_target_user_id = p_user_id[\s\S]*state = 'copying'/i,
    );
    expect(beginFunction).toMatch(/message = 'Guest claim must settle before account erasure starts'/i);
    expect(beginFunction!.indexOf("private.guest_draft_recoveries")).toBeLessThan(
      beginFunction!.indexOf("insert into private.account_erasure_generations"),
    );
  });

  it("rejects a guest claim under the target erasure lock before binding it", () => {
    const claimFunction = migration.match(
      /create or replace function public\.begin_guest_draft_claim\([\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(claimFunction).toBeDefined();

    const targetLock = claimFunction!.indexOf(
      "private.lock_account_erasure(p_target_user_id)",
    );
    const generationCheck = claimFunction!.indexOf(
      "from private.account_erasure_generations generation",
    );
    const firstBinding = claimFunction!.indexOf(
      "set claim_idempotency_user_id = p_target_user_id",
    );
    expect(targetLock).toBeGreaterThan(0);
    expect(generationCheck).toBeGreaterThan(targetLock);
    expect(firstBinding).toBeGreaterThan(generationCheck);
    expect(claimFunction).toContain(
      "message = 'Account erasure has started for this account'",
    );
  });

  it("evaluates ambiguous eBay authority before permitting tenant deletion", () => {
    const fenceFunction = migration.match(
      /create function private\.fence_account_erasure_tenant_mutation\(\)[\s\S]*?\n\$\$;/i,
    )?.[0];
    const advanceFunction = migration.match(
      /create function public\.advance_account_erasure\([\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(fenceFunction).toBeDefined();
    expect(advanceFunction).toBeDefined();
    expect(fenceFunction).not.toMatch(/v_allow_existing_provider_completion\s*:=\s*\n?\s*tg_op = 'DELETE'/i);
    expect(fenceFunction).toMatch(
      /tg_table_name = 'ebay_provider_dispatch_leases'[\s\S]*tg_op in \('UPDATE', 'DELETE'\)/i,
    );
    expect(advanceFunction!.indexOf("external-ebay-authority-pending")).toBeLessThan(
      advanceFunction!.indexOf("delete from public.listings"),
    );
  });

  it("admits only lease-authenticated eBay completion writes after the fence", () => {
    const completionFunction = migration.match(
      /create or replace function private\.assert_ebay_dispatch_completion\([\s\S]*?\n\$\$;/i,
    )?.[0];
    const fenceFunction = migration.match(
      /create function private\.fence_account_erasure_tenant_mutation\(\)[\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(completionFunction).toBeDefined();
    expect(fenceFunction).toBeDefined();
    const leaseCheck = completionFunction!.indexOf("from private.ebay_provider_dispatch_leases lease");
    const completionGrant = completionFunction!.indexOf(
      "set_config('app.account_erasure_provider_completion_user_id'",
    );
    const accountLock = completionFunction!.indexOf("private.lock_ebay_messaging_account");
    expect(leaseCheck).toBeGreaterThan(0);
    expect(completionGrant).toBeGreaterThan(leaseCheck);
    expect(accountLock).toBeGreaterThan(completionGrant);
    for (const setting of [
      "app.account_erasure_provider_completion_user_id",
      "app.account_erasure_provider_completion_resource_id",
      "app.account_erasure_provider_completion_operation",
    ]) {
      expect(completionFunction).toContain(setting);
      expect(fenceFunction).toContain(setting);
    }
    expect(fenceFunction).toMatch(
      /tg_table_name = 'ebay_messaging_account_generations'[\s\S]*tg_op = 'INSERT'/i,
    );
    expect(fenceFunction).toMatch(
      /v_provider_operation = 'publish'[\s\S]*tg_table_name = 'listings'[\s\S]*v_old->>'ebay_status' = 'publishing'[\s\S]*v_new->>'ebay_status' = 'published'/i,
    );
    expect(fenceFunction).toMatch(
      /v_provider_operation = 'reprice'[\s\S]*tg_table_name in \('reprice_suggestions', 'items', 'listings'\)/i,
    );
    expect(fenceFunction).not.toMatch(/v_new->>'ebay_status' in \('published', 'failed'\)/i);
  });

  it("reconciles credits and queues before exact tenant absence can complete", () => {
    expect(migration).toMatch(/private\.restore_ai_item_credit\(v_run_id\)/i);
    expect(migration).toMatch(/pgmq\.delete\('pipeline_jobs', v_queue_id\)/i);
    expect(migration).toMatch(/delete from pgmq\.a_pipeline_jobs/i);
    expect(migration).toMatch(
      /public\.delete_mobile_ebay_oauth_sessions_for_account_erasure\([\s\S]*v_generation\.user_id/i,
    );
    expect(migration).toMatch(/private\.account_erasure_owned_row_count\(v_generation\.user_id\) <> 0/i);
    expect(migration).toMatch(/message = 'Mandatory account erasure proof is incomplete'/i);
  });

  it("returns completion from the atomic scrub without retaining a user-linked receipt", () => {
    const advanceFunction = migration.match(
      /create function public\.advance_account_erasure\([\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(advanceFunction).toBeDefined();
    expect(advanceFunction).toMatch(
      /v_completion_payload\s*:=\s*jsonb_build_object\([\s\S]*'status', 'complete'/i,
    );
    expect(advanceFunction).toMatch(
      /delete from private\.account_erasure_generations[\s\S]*where generation_id = p_generation_id/i,
    );
    expect(advanceFunction!.indexOf("Mandatory account erasure proof is incomplete")).toBeLessThan(
      advanceFunction!.indexOf("delete from private.account_erasure_generations"),
    );
    expect(advanceFunction!.indexOf("delete from private.account_erasure_generations")).toBeLessThan(
      advanceFunction!.indexOf("return v_completion_payload"),
    );
    expect(advanceFunction).not.toMatch(/set status = 'complete'/i);
  });

  it("keeps provider and legal uncertainty explicit without ending an eBay listing", () => {
    for (const blocker of [
      "hosted-transcription-retention",
      "ebay-publish-receipt-obligations",
      "clerk-identity-retention",
      "apple-revenuecat-reference-obligations",
      "external-ebay-authority-pending",
    ]) {
      expect(migration).toContain(blocker);
    }
    expect(migration).not.toMatch(/end(Item|Listing)|deleteInventoryItem|withdrawOffer/i);
  });
});
