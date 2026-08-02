import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    "supabase/migrations/20260801230000_mobile_guided_correction_identity_and_idempotency.sql",
  ),
  "utf8",
);

const listingRegenerationMigration = readFileSync(
  resolve(
    "supabase/migrations/20260802204000_mobile_guided_correction_listing_regeneration.sql",
  ),
  "utf8",
);

const sharpenOrigin = readFileSync(
  resolve(
    "supabase/migrations/20260713003000_review_identity_regeneration.sql",
  ),
  "utf8",
);

const listingReviewSave = readFileSync(
  resolve("supabase/migrations/20260730060000_mobile_listing_review_save.sql"),
  "utf8",
);

const erasureOrigin = readFileSync(
  resolve(
    "supabase/migrations/20260801200000_included_offer_account_erasure_coverage.sql",
  ),
  "utf8",
);

/**
 * Extracts one `create [or replace] function … $$ … $$;` block verbatim.
 * Both erasure functions are `$$`-quoted and neither body contains a nested
 * `$$`, which is what makes the naive scan exact rather than approximate.
 */
function functionBlock(source: string, qualifiedName: string): string {
  const start = source.indexOf(`create or replace function ${qualifiedName}`);
  expect(start, `${qualifiedName} is not redefined here`).toBeGreaterThan(-1);
  const bodyOpen = source.indexOf("$$", start);
  const bodyClose = source.indexOf("$$;", bodyOpen + 2);
  return source.slice(start, bodyClose + 3);
}

describe("guided identity correction migration", () => {
  it("is what makes a corrected identity reach the column the client reads", () => {
    // The original RPC wrote `attributes` only, because the web sharpen it was
    // built for never moved the identity — that went through
    // `regenerate_review_listing`. `get_mobile_listing_review` projects
    // `items.identification` verbatim, so on the native seam the seller was
    // reading back the identity they had just replaced.
    expect(sharpenOrigin).not.toMatch(
      /create or replace function public\.sharpen_review_estimate[\s\S]*?identification = /i,
    );
    expect(migration).toMatch(
      /update public\.items\s*set attributes = p_attributes,\s*identification = coalesce\(p_identification, identification\)/i,
    );
  });

  it("leaves the identity alone when the seller only added specs", () => {
    // `coalesce` is the whole contract for a specs-only sharpen: it re-prices,
    // it does not re-identify, so the vision step's identification must survive.
    expect(migration).toMatch(/p_identification jsonb default null/i);
    expect(migration).toMatch(
      /if p_identification is not null\s*and jsonb_typeof\(p_identification\) is distinct from 'object' then[\s\S]*?errcode = '22023'/i,
    );
  });

  it("keeps every guard the correction already relied on", () => {
    // Recreating a function is where guards quietly disappear. Each of these is
    // load-bearing: the revision guard is the optimistic-concurrency contract,
    // the listing lock plus publish check is what refuses a provider-owned
    // listing, and the export-pack delete is what stops a stale pack shipping.
    expect(migration).toMatch(
      /review_revision is not distinct from p_expected_review_revision/i,
    );
    expect(migration).toMatch(
      /if not found then[\s\S]*?errcode = 'P0002'[\s\S]*?Review changed\. Reload and try again\./i,
    );
    expect(migration).toMatch(/from public\.listings[\s\S]*?for update;/i);
    expect(migration).toMatch(
      /ebay_status is not distinct from 'publishing'[\s\S]*?ebay_status is not distinct from 'published'/i,
    );
    expect(migration).toMatch(/insert into public\.prediction_logs/i);
    expect(migration).toMatch(
      /delete from public\.listings[\s\S]*?platform in \('facebook', 'mercari'\)/i,
    );
    expect(migration).toMatch(/security invoker/i);
  });

  it("keeps the recreated function reachable from its existing callers", () => {
    // Dropping and recreating changes the signature, so the old overload has to
    // go and the new argument has to be last and defaulted — otherwise every
    // named-argument caller stops resolving.
    expect(migration).toMatch(
      /drop function public\.sharpen_review_estimate\(\s*uuid, uuid, uuid, jsonb, numeric, jsonb, numeric, text, text, text, text, jsonb,\s*boolean, boolean\s*\);/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.sharpen_review_estimate\([\s\S]*?boolean, boolean, jsonb\s*\) to authenticated;/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.sharpen_review_estimate\([\s\S]*?\) from public, anon, service_role;/i,
    );
  });
});

describe("guided correction idempotency claim migration", () => {
  it("reuses the durable claim shape PUT /review already proved", () => {
    for (const pattern of [
      /state text not null default 'pending'/i,
      /check \(state in \('pending', 'completed', 'failed'\)\)/i,
      /lease_expires_at timestamptz/i,
      /primary key \(user_id, idempotency_key\)/i,
      /references public\.pipeline_runs\(id\) on delete cascade/i,
    ]) {
      expect(listingReviewSave).toMatch(pattern);
      expect(migration).toMatch(pattern);
    }
    expect(migration).toMatch(
      /create table private\.mobile_guided_corrections/i,
    );
    expect(migration).toMatch(
      /revoke all on table private\.mobile_guided_corrections\s*from public, anon, authenticated;/i,
    );
  });

  it("refuses to let a second correction on one revision reach the provider", () => {
    // This is the whole point of the claim: two POSTs holding the same
    // `expectedReviewRevision` both clear the cheap pre-check, exactly one can
    // win the revision guard, and the loser's pricing spend is billed and then
    // discarded. `prepare` has to answer `in_progress` BEFORE any of that.
    expect(migration).toMatch(
      /competing\.expected_review_revision = p_expected_review_revision[\s\S]*?competing\.idempotency_key is distinct from p_idempotency_key[\s\S]*?competing\.state = 'pending'[\s\S]*?lease_expires_at > statement_timestamp\(\)[\s\S]*?\) then\s*return jsonb_build_object\('state', 'in_progress'\);/i,
    );
    expect(migration).toMatch(
      /p_action not in \('prepare', 'fail'\)/i,
    );
    expect(migration).not.toMatch(/if p_action = 'complete' then/i);
    expect(migration).toMatch(
      /return jsonb_build_object\(\s*'state', 'proceed',\s*'attemptGeneration', v_claim\.attempt_generation\s*\)/i,
    );
  });

  it("refuses to answer one intent with another intent's receipt", () => {
    expect(migration).toMatch(
      /v_claim\.intent is distinct from p_intent[\s\S]*?already bound to a different correction/i,
    );
  });

  it("fences an expired-lease reclaim with a new attempt generation", () => {
    expect(migration).toMatch(
      /attempt_generation bigint not null default 1/i,
    );
    expect(migration).toMatch(
      /set state = 'pending',[\s\S]*?attempt_generation = attempt_generation \+ 1[\s\S]*?returning \* into v_claim/i,
    );
    expect(migration).toMatch(
      /jsonb_build_object\(\s*'state', 'proceed',\s*'attemptGeneration', v_claim\.attempt_generation\s*\)/i,
    );
    expect(migration).toMatch(
      /p_action = 'fail'[\s\S]*?v_claim\.attempt_generation is distinct from p_attempt_generation[\s\S]*?return jsonb_build_object\('state', 'unchanged'\)/i,
    );

    const completion = functionBlock(
      listingRegenerationMigration,
      "public.complete_mobile_guided_correction",
    );
    expect(completion).toMatch(/p_attempt_generation bigint/i);
    expect(completion).toMatch(
      /v_claim\.attempt_generation is distinct from p_attempt_generation/i,
    );
  });

  it("fences allowance authorization to the current attempt generation", () => {
    const authorization = functionBlock(
      migration,
      "public.authorize_mobile_guided_correction",
    );
    expect(authorization).toMatch(/p_attempt_generation bigint/i);
    expect(authorization).toMatch(
      /claim\.attempt_generation = p_attempt_generation[\s\S]*?claim\.state = 'pending'/i,
    );
    expect(authorization).toMatch(
      /return public\.authorize_ai_item_guided_correction\(/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.authorize_mobile_guided_correction\([\s\S]*?\) to authenticated;/i,
    );
  });

  it("bounds definer rights to the caller's own tenancy", () => {
    // `security definer` plus a run lookup that is not tenant-scoped would turn
    // the claim into a cross-tenant existence probe.
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path = ''/i);
    expect(migration).toMatch(
      /from public\.pipeline_runs run\s*where run\.id = p_run_id\s*and run\.user_id = v_user_id\s*for update;/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.claim_mobile_guided_correction\(\s*text, uuid, uuid, uuid, jsonb, bigint\s*\) from public, anon, service_role;/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.claim_mobile_guided_correction\(\s*text, uuid, uuid, uuid, jsonb, bigint\s*\) to authenticated;/i,
    );
  });
});

describe("mobile guided correction atomic completion", () => {
  it("adds regenerated eBay copy to the existing atomic completion", () => {
    const completion = functionBlock(
      listingRegenerationMigration,
      "public.complete_mobile_guided_correction",
    );
    const itemWrite = completion.indexOf("update public.items");
    const listingWrite = completion.indexOf("update public.listings");
    const predictionWrite = completion.indexOf(
      "insert into public.prediction_logs",
    );
    const receiptWrite = completion.indexOf(
      "update private.mobile_guided_corrections",
    );

    expect(itemWrite).toBeGreaterThan(-1);
    expect(listingWrite).toBeGreaterThan(itemWrite);
    expect(predictionWrite).toBeGreaterThan(listingWrite);
    expect(receiptWrite).toBeGreaterThan(predictionWrite);
    expect(completion).toMatch(
      /set title = v_listing->>'title',\s*description = v_listing->>'description',\s*copy = v_listing->'copy',\s*status = 'draft',\s*run_id = v_cap\.completion_run_id/i,
    );
    expect(completion).toMatch(
      /run_id = v_cap\.completion_run_id,\s*source_review_revision = v_cap\.completion_run_id/i,
    );
    expect(completion).toMatch(
      /where id = v_cap\.listing_id[\s\S]*?item_id = v_cap\.item_id[\s\S]*?user_id = v_cap\.user_id[\s\S]*?platform = 'ebay'[\s\S]*?run_id is not distinct from v_cap\.expected_run_id/i,
    );
  });

  it("writes the correction, included allowance, and replay receipt in one RPC", () => {
    const completion = functionBlock(
      listingRegenerationMigration,
      "public.complete_mobile_guided_correction",
    );
    const itemWrite = completion.indexOf("update public.items");
    const allowanceWrite = completion.indexOf(
      "update public.ai_item_credit_reservations",
    );
    const receiptWrite = completion.indexOf(
      "update private.mobile_guided_corrections",
    );

    expect(itemWrite).toBeGreaterThan(-1);
    expect(allowanceWrite).toBeGreaterThan(itemWrite);
    expect(receiptWrite).toBeGreaterThan(allowanceWrite);
    expect(completion).toMatch(
      /set guided_correction_completed_at = v_now/i,
    );
    expect(completion).toMatch(
      /set state = 'completed',\s*lease_expires_at = null,\s*receipt = p_receipt/i,
    );
    expect(completion).toMatch(
      /item\.review_revision is not distinct from v_cap\.expected_review_revision/i,
    );
  });

  it("writes immutable corrected pricing evidence beside the fresh prediction", () => {
    const completion = functionBlock(
      listingRegenerationMigration,
      "public.complete_mobile_guided_correction",
    );
    const predictionWrite = completion.indexOf(
      "insert into public.prediction_logs",
    );
    const evidenceWrite = completion.indexOf(
      "insert into public.pricing_evidence_snapshots",
    );

    expect(predictionWrite).toBeGreaterThan(-1);
    expect(completion).toMatch(/returning id into v_prediction_id/i);
    expect(evidenceWrite).toBeGreaterThan(predictionWrite);
    expect(completion).toMatch(
      /v_cap\.completion_run_id, null, 'review-correction', v_cap\.user_id,[\s\S]*?v_cap\.item_id, v_prediction_id, v_cap\.listing_id, 1,[\s\S]*?v_snapshot->'item', v_snapshot->'price_result', v_evidence, v_now/i,
    );
  });

  it("keeps completion behind the existing tenant-bound capability", () => {
    const completion = functionBlock(
      listingRegenerationMigration,
      "public.complete_mobile_guided_correction",
    );

    expect(completion).toMatch(
      /from private\.guided_correction_completion_capabilities capability[\s\S]*?where capability\.token_hash = encode/i,
    );
    expect(completion).toMatch(
      /reservation\.guided_correction_completed_at is null/i,
    );
    expect(completion).toMatch(
      /reservation\.photo_identity_kind = item\.photo_identity_kind[\s\S]*?reservation\.photo_identity_fingerprint = item\.photo_identity_fingerprint[\s\S]*?reservation\.photo_identity_kind = 'content_sha256_set_v1'/i,
    );
    expect(listingRegenerationMigration).toMatch(
      /revoke all on function public\.complete_mobile_guided_correction\(\s*text, uuid, bigint, jsonb, jsonb\s*\) from public, anon, authenticated;/i,
    );
    expect(listingRegenerationMigration).toMatch(
      /grant execute on function public\.complete_mobile_guided_correction\(\s*text, uuid, bigint, jsonb, jsonb\s*\) to service_role;/i,
    );
  });
});

describe("account erasure coverage for the claim table", () => {
  it("refuses a write and counts a row once the owner is being erased", () => {
    // `account_erasure.test.sql` derives every `user_id`-bearing table into its
    // erasure scope, so adding this table without both halves failed CI rather
    // than shipping a tenant table erasure could neither fence nor finish.
    expect(migration).toMatch(
      /create trigger zzz_fence_account_erasure_tenant_mutation\s*before insert or update or delete on private\.mobile_guided_corrections\s*for each row execute function private\.fence_account_erasure_tenant_mutation\(\);/i,
    );
    expect(migration).toMatch(
      /union all select count\(\*\)::integer from private\.mobile_guided_corrections where user_id = p_user_id/i,
    );
    // Not redundant with `run_id … on delete cascade`: the count predicate is
    // `user_id` and the cascade travels `run_id`. A row whose denormalized
    // `user_id` is the erasing tenant against another tenant's run is counted
    // by a predicate no foreign key participates in, and pgTAP proves erasure
    // strands on "Mandatory account erasure work is incomplete" without this.
    expect(migration).toMatch(
      /delete from private\.mobile_guided_corrections where user_id = v_generation\.user_id;/i,
    );
  });

  it("re-declares the erasure engine without changing anything else in it", () => {
    // Adding a counted table means reissuing two functions this issue does not
    // own, because Postgres has no way to append a statement to a function
    // body. That is the whole risk: a transcription slip here silently replaces
    // account deletion for every tenant, and no test in this PR's own scope
    // would notice. So the diff itself is the assertion — each function must be
    // byte-identical to 20260801200000 apart from its one added line.
    const additions: Record<string, string> = {
      "private.account_erasure_owned_row_count":
        "    union all select count(*)::integer from private.mobile_guided_corrections where user_id = p_user_id\n",
      "public.advance_account_erasure":
        "  delete from private.mobile_guided_corrections where user_id = v_generation.user_id;\n",
    };

    for (const [name, addedLine] of Object.entries(additions)) {
      const reissued = functionBlock(migration, name);
      expect(reissued).toContain(addedLine);
      expect(reissued.replace(addedLine, "")).toBe(
        functionBlock(erasureOrigin, name),
      );
    }
  });
});
