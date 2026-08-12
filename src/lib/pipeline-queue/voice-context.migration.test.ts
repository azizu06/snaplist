import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260811120000_durable_seller_voice_context.sql",
    import.meta.url,
  ),
  "utf8",
);
const terminalRetentionMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260720230000_mobile_submission_cleanup_replay_fence.sql",
    import.meta.url,
  ),
  "utf8",
);
const providerUsagePgtap = readFileSync(
  new URL(
    "../../../supabase/tests/pipeline_run_provider_usage.test.sql",
    import.meta.url,
  ),
  "utf8",
);
const selectorAcceptanceMap = readFileSync(
  new URL(
    "../../../docs/review-evidence/774/test-selector-acceptance-map.md",
    import.meta.url,
  ),
  "utf8",
);
const migrationsDirectory = new URL("../../../supabase/migrations/", import.meta.url);
const reconciliationMigrationName =
  "20260811123000_reconcile_durable_seller_voice_context.sql";
const reconciliationMigrationUrl = new URL(
  reconciliationMigrationName,
  migrationsDirectory,
);
const reconciliationMigration = existsSync(reconciliationMigrationUrl)
  ? readFileSync(reconciliationMigrationUrl, "utf8")
  : "";

function functionDefinition(sql: string, functionName: string): string {
  const start = sql.indexOf(`create or replace function ${functionName}`);
  if (start === -1) return "";
  const end = sql.indexOf("\n$$;", start);
  if (end === -1) return "";
  return sql.slice(start, end + "\n$$;".length);
}

describe("durable seller voice worker migration", () => {
  it("derives one accepted voice receipt from the claimed run, item, and tenant", () => {
    expect(migration).toMatch(
      /create or replace function private\.pipeline_worker_context_json\(p_run_id uuid\)/i,
    );
    expect(migration).toMatch(
      /handoff\.run_id\s*=\s*run\.id[\s\S]*handoff\.user_id\s*=\s*run\.user_id[\s\S]*handoff\.item_id\s*=\s*run\.item_id[\s\S]*handoff\.state\s*=\s*'accepted'/i,
    );
    expect(migration).toMatch(/'voice'[\s\S]*'receipt'/i);
  });

  it("records only a bounded terminal outcome through the live run lease", () => {
    const voiceOutcomeCapability = migration.slice(
      migration.indexOf(
        "create or replace function public.record_pipeline_run_voice_outcome",
      ),
      migration.indexOf(
        "revoke all on function public.record_pipeline_run_voice_outcome",
      ),
    );
    expect(migration).toMatch(
      /create or replace function public\.record_pipeline_run_voice_outcome\([\s\S]*p_run_id uuid[\s\S]*p_lease_token uuid[\s\S]*p_outcome text[\s\S]*p_provider_contacted boolean/i,
    );
    expect(migration).toMatch(/run\.lease_token\s*=\s*p_lease_token/i);
    expect(migration).toMatch(/run\.lease_expires_at\s*>\s*statement_timestamp\(\)/i);
    expect(migration).toMatch(
      /record_raw_seller_voice_transcription_outcome\(\s*v_user_id,\s*p_run_id,\s*p_outcome\s*\)/i,
    );
    expect(voiceOutcomeCapability).not.toMatch(/p_user_id/i);
    expect(voiceOutcomeCapability).not.toMatch(
      /p_transcript|p_language|p_audio/i,
    );
  });

  it("records explicit provider contact provenance before erasure disclosure", () => {
    expect(migration).toMatch(
      /add column terminal_voice_outcome text[\s\S]*add column transcription_provider_contacted boolean/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.record_pipeline_run_voice_outcome\([\s\S]*p_provider_contacted boolean/i,
    );
    expect(migration).toMatch(
      /set terminal_voice_outcome = p_outcome[\s\S]*transcription_provider_contacted = p_provider_contacted[\s\S]*transcription_outcome = case[\s\S]*when p_provider_contacted then p_outcome[\s\S]*else null/i,
    );
  });

  it("persists aggregate transcription cost authority without voice content", () => {
    expect(migration).toMatch(
      /add column transcriptions jsonb not null default '\[\]'::jsonb/i,
    );
    expect(migration).toMatch(
      /array\['role', 'provider', 'model', 'calls', 'chargedUsd'\]/i,
    );
    expect(migration).toMatch(
      /coalesce\(p_usage->'transcriptions', '\[\]'::jsonb\)/i,
    );
    expect(migration).not.toMatch(/p_usage->'(audio|transcript|language)'/i);
  });

  it("locks the authoritative lease row through the provider usage mutation", () => {
    const usageCapability = migration.slice(
      migration.indexOf(
        "create or replace function public.record_pipeline_run_provider_usage",
      ),
      migration.indexOf(
        "revoke all on function public.record_pipeline_run_provider_usage",
      ),
    );
    expect(usageCapability).toMatch(
      /select pr\.user_id, pr\.item_id[\s\S]*from public\.pipeline_runs pr[\s\S]*pr\.lease_expires_at > statement_timestamp\(\)[\s\S]*for update/i,
    );
    expect(usageCapability.indexOf("for update")).toBeLessThan(
      usageCapability.indexOf("insert into public.pipeline_run_provider_usage"),
    );
  });

  it("rejects malformed transcription receipts before persistence with one fixed error", () => {
    const usageCapability = migration.slice(
      migration.indexOf(
        "create or replace function public.record_pipeline_run_provider_usage",
      ),
      migration.indexOf(
        "revoke all on function public.record_pipeline_run_provider_usage",
      ),
    );
    expect(usageCapability).toMatch(
      /if v_transcriptions <> '\[\]'::jsonb[\s\S]*and not v_incoming_transcription_only then[\s\S]*errcode = '22023'[\s\S]*message = 'Invalid provider usage record'/i,
    );
    expect(usageCapability.indexOf("and not v_incoming_transcription_only then")).toBeLessThan(
      usageCapability.indexOf("insert into public.pipeline_run_provider_usage"),
    );
  });

  it("validates provider usage scalar types and bounds before numeric conversion", () => {
    const usageCapability = migration.slice(
      migration.indexOf(
        "create or replace function public.record_pipeline_run_provider_usage",
      ),
      migration.indexOf(
        "revoke all on function public.record_pipeline_run_provider_usage",
      ),
    );
    expect(migration).toMatch(
      /create or replace function private\.provider_usage_record_is_strict\(p_usage jsonb\)[\s\S]*private\.provider_usage_nonnegative_integer/i,
    );
    expect(usageCapability).toMatch(/v_model_calls numeric := 0/i);
    const declaration = usageCapability.slice(
      usageCapability.indexOf("declare"),
      usageCapability.indexOf("begin"),
    );
    expect(declaration).not.toMatch(
      /p_usage->>'(?:modelCalls|inputTokens|cachedInputTokens|outputTokens|reasoningTokens)'\)::numeric/i,
    );
    expect(usageCapability).toMatch(
      /if not private\.provider_usage_record_is_strict\(p_usage\) then[\s\S]*errcode = '22023'[\s\S]*message = 'Invalid provider usage record'[\s\S]*end if;[\s\S]*v_model_calls := \(p_usage->>'modelCalls'\)::numeric/i,
    );
  });

  it("merges one failed-attempt transcription receipt with replay usage exactly once", () => {
    const usageCapability = migration.slice(
      migration.indexOf(
        "create or replace function public.record_pipeline_run_provider_usage",
      ),
      migration.indexOf(
        "revoke all on function public.record_pipeline_run_provider_usage",
      ),
    );
    expect(usageCapability).toMatch(
      /on conflict \(run_id\) do update[\s\S]*model_calls\s*=\s*pipeline_run_provider_usage\.model_calls\s*\+\s*excluded\.model_calls/i,
    );
    expect(usageCapability).toMatch(
      /transcriptions\s*=\s*case[\s\S]*else pipeline_run_provider_usage\.transcriptions[\s\S]*end/i,
    );
    expect(usageCapability).toMatch(
      /where\s*\(\s*pipeline_run_provider_usage\.models\s*=\s*'\[\]'::jsonb[\s\S]*pipeline_run_provider_usage\.sold_comps\s*=\s*'\[\]'::jsonb[\s\S]*pipeline_run_provider_usage\.transcriptions\s*<>\s*'\[\]'::jsonb[\s\S]*excluded\.transcriptions\s*=\s*'\[\]'::jsonb/i,
    );
  });

  it("merges one late transcription receipt into old-worker usage and reports conflicts truthfully", () => {
    const usageCapability = migration.slice(
      migration.indexOf(
        "create or replace function public.record_pipeline_run_provider_usage",
      ),
      migration.indexOf(
        "revoke all on function public.record_pipeline_run_provider_usage",
      ),
    );
    expect(usageCapability).toMatch(
      /pipeline_run_provider_usage\.transcriptions\s*=\s*'\[\]'::jsonb[\s\S]*pipeline_run_provider_usage\.models\s*<>\s*'\[\]'::jsonb[\s\S]*v_incoming_transcription_only/i,
    );
    expect(usageCapability).toMatch(
      /models\s*=\s*case[\s\S]*v_incoming_transcription_only[\s\S]*pipeline_run_provider_usage\.models/i,
    );
    expect(usageCapability).toMatch(
      /transcriptions\s*=\s*case[\s\S]*v_incoming_transcription_only[\s\S]*excluded\.transcriptions/i,
    );
    expect(usageCapability).toMatch(
      /get diagnostics v_rows\s*=\s*row_count[\s\S]*if v_rows\s*=\s*1 then[\s\S]*return true/i,
    );
    expect(usageCapability).toMatch(
      /raise exception using[\s\S]*message\s*=\s*'Provider usage conflicts with the durable run receipt'/i,
    );
  });

  it("merges an empty legacy full-first row with one late transcription exactly once", () => {
    const usageCapability = migration.slice(
      migration.indexOf(
        "create or replace function public.record_pipeline_run_provider_usage",
      ),
      migration.indexOf(
        "revoke all on function public.record_pipeline_run_provider_usage",
      ),
    );
    expect(usageCapability).toMatch(
      /pipeline_run_provider_usage\.transcriptions\s*=\s*'\[\]'::jsonb[\s\S]*pipeline_run_provider_usage\.model_calls\s*=\s*0[\s\S]*pipeline_run_provider_usage\.input_tokens\s*=\s*0[\s\S]*pipeline_run_provider_usage\.models\s*=\s*'\[\]'::jsonb[\s\S]*pipeline_run_provider_usage\.sold_comps\s*=\s*'\[\]'::jsonb[\s\S]*v_incoming_transcription_only/i,
    );
  });

  it("retains one typed seller context with the item after terminal run pruning", () => {
    expect(migration).toMatch(
      /create table private\.item_seller_voice_contexts/i,
    );
    expect(migration).toMatch(
      /item_seller_voice_contexts[\s\S]*transcript text not null[\s\S]*language text[\s\S]*provenance text[\s\S]*verification text/i,
    );
    expect(migration).toMatch(
      /foreign key \(item_id, user_id\)[\s\S]*references public\.items \(id, user_id\)[\s\S]*on update cascade[\s\S]*on delete cascade/i,
    );
    expect(migration).toMatch(
      /alter table private\.item_seller_voice_contexts enable row level security[\s\S]*revoke all on table private\.item_seller_voice_contexts/i,
    );
    expect(migration).toMatch(
      /create trigger retain_pipeline_seller_context[\s\S]*after update of status on public\.pipeline_runs/i,
    );
    expect(migration).toMatch(
      /new\.status = 'succeeded'[\s\S]*new\.checkpoint[\s\S]*insert into private\.item_seller_voice_contexts/i,
    );
    expect(terminalRetentionMigration).toMatch(/checkpoint = '\{\}'::jsonb/i);
    expect(terminalRetentionMigration).not.toMatch(
      /delete from private\.item_seller_voice_contexts/i,
    );
  });

  it("fences and counts retained seller context during account erasure", () => {
    expect(migration).toMatch(
      /create trigger zzz_fence_account_erasure_tenant_mutation[\s\S]*on private\.item_seller_voice_contexts[\s\S]*private\.fence_account_erasure_tenant_mutation\(\)/i,
    );
    expect(migration).toMatch(
      /create or replace function private\.account_erasure_owned_row_count\(p_user_id text\)[\s\S]*from private\.item_seller_voice_contexts where user_id = p_user_id/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.account_erasure_owned_row_count\(text\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
  });

  it("keeps the capability service-only", () => {
    expect(migration).toMatch(
      /drop function if exists public\.record_pipeline_run_voice_outcome\(\s*uuid, uuid, text\s*\)/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.record_pipeline_run_voice_outcome\([\s\S]*uuid, uuid, text, boolean[\s\S]*from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_pipeline_run_voice_outcome\([\s\S]*uuid, uuid, text, boolean[\s\S]*to service_role/i,
    );
  });

  it("fails the provider usage pgTAP bootstrap closed without the exact issue schema", () => {
    expect(providerUsagePgtap).toMatch(
      /information_schema\.columns[\s\S]*column_name = 'transcriptions'/i,
    );
    expect(providerUsagePgtap).toMatch(
      /provider_usage_record_is_strict'[\s\S]*pg_get_functiondef/i,
    );
    expect(providerUsagePgtap).toMatch(
      /position\('for update' in lower\(pg_get_functiondef/i,
    );
    expect(providerUsagePgtap).toMatch(
      /\\if :require_issue_774_schema[\s\S]*\\else[\s\S]*\\quit 3/i,
    );
  });

  it("proves malformed receipts and scalars fail with the fixed content-free error", () => {
    expect(providerUsagePgtap).toMatch(
      /a transcription receipt with a missing field is rejected before persistence/i,
    );
    expect(providerUsagePgtap).toMatch(
      /a transcription receipt with a wrong field type is rejected before persistence/i,
    );
    expect(providerUsagePgtap).toMatch(
      /a transcription receipt with an extra text field is rejected without echoing it/i,
    );
    expect(providerUsagePgtap).toMatch(
      /a malformed numeric scalar is rejected without echoing it/i,
    );
  });

  it("proves the empty legacy full-first merge, replay, and conflict in pgTAP", () => {
    expect(providerUsagePgtap).toMatch(
      /an all-zero old-worker row accepts one late transcription receipt/i,
    );
    expect(providerUsagePgtap).toMatch(
      /the all-zero late receipt replays idempotently/i,
    );
    expect(providerUsagePgtap).toMatch(
      /a different late receipt conflicts with the all-zero old-worker row/i,
    );
  });
});

describe("durable seller voice reconciliation migration", () => {
  it("orders one unique reconciliation migration after the clean-install authority", () => {
    const matchingMigrations = readdirSync(migrationsDirectory).filter((file) =>
      file.startsWith("20260811123000_"),
    );

    expect(matchingMigrations).toEqual([reconciliationMigrationName]);
    expect(reconciliationMigration).not.toBe("");
    expect(
      reconciliationMigrationName.localeCompare(
        "20260811120000_durable_seller_voice_context.sql",
      ),
    ).toBeGreaterThan(0);
  });

  it("adds provider-contact provenance without inventing it for legacy outcomes", () => {
    const provenanceSetup = reconciliationMigration.slice(
      reconciliationMigration.indexOf(
        "alter table private.mobile_item_submission_voice_handoffs",
      ),
      reconciliationMigration.indexOf("do $reconcile_provenance_constraint$"),
    );

    expect(reconciliationMigration).toMatch(
      /alter table private\.mobile_item_submission_voice_handoffs[\s\S]*add column if not exists terminal_voice_outcome text[\s\S]*add column if not exists transcription_provider_contacted boolean/i,
    );
    expect(provenanceSetup).toMatch(
      /legacy transcription_outcome remains the conservative disclosure signal[\s\S]*new provenance[\s\S]*remains null/i,
    );
    expect(provenanceSetup).not.toMatch(/\bupdate\b|\bdefault\b/i);
    expect(reconciliationMigration).not.toMatch(
      /transcription_provider_contacted boolean[^;]*default/i,
    );
    expect(reconciliationMigration).toMatch(
      /select pg_get_constraintdef\(constraint_record\.oid, true\)[\s\S]*mobile_voice_terminal_provider_provenance_check[\s\S]*v_existing_provenance_definition is distinct from[\s\S]*alter table private\.mobile_item_submission_voice_handoffs[\s\S]*add constraint mobile_voice_terminal_provider_provenance_check/i,
    );
    expect(reconciliationMigration).toMatch(
      /alter table private\.mobile_item_submission_voice_handoffs[\s\S]*validate constraint mobile_voice_terminal_provider_provenance_check/i,
    );
  });

  it("reinstalls the exact corrected RPC and strict usage definitions with narrow grants", () => {
    const correctedFunctions = [
      "public.record_pipeline_run_voice_outcome",
      "private.provider_usage_nonnegative_integer",
      "private.provider_usage_nonnegative_decimal",
      "private.provider_usage_record_is_strict",
      "public.record_pipeline_run_provider_usage",
    ];

    for (const functionName of correctedFunctions) {
      expect(functionDefinition(reconciliationMigration, functionName)).toBe(
        functionDefinition(migration, functionName),
      );
    }

    expect(reconciliationMigration).toMatch(
      /drop function if exists public\.record_pipeline_run_voice_outcome\(\s*uuid, uuid, text\s*\)/i,
    );
    expect(reconciliationMigration).toMatch(
      /revoke all on function public\.record_pipeline_run_voice_outcome\(\s*uuid, uuid, text, boolean\s*\)[\s\S]*from public, anon, authenticated, service_role[\s\S]*grant execute on function public\.record_pipeline_run_voice_outcome\(\s*uuid, uuid, text, boolean\s*\)[\s\S]*to service_role/i,
    );
    expect(reconciliationMigration).toMatch(
      /revoke all on function public\.record_pipeline_run_provider_usage\(uuid, uuid, jsonb\)[\s\S]*from public, anon, authenticated;[\s\S]*grant execute on function public\.record_pipeline_run_provider_usage\(uuid, uuid, jsonb\)[\s\S]*to service_role/i,
    );
  });

  it("fails closed before mutation unless the accepted issue schema exists", () => {
    const bootstrapEnd = reconciliationMigration.indexOf(
      "alter table private.mobile_item_submission_voice_handoffs",
    );
    const bootstrap = reconciliationMigration.slice(0, bootstrapEnd);

    expect(bootstrap).toMatch(
      /do \$reconciliation_prerequisites\$[\s\S]*to_regclass\('private\.mobile_item_submission_voice_handoffs'\)[\s\S]*to_regclass\('private\.item_seller_voice_contexts'\)[\s\S]*to_regclass\('public\.pipeline_run_provider_usage'\)/i,
    );
    expect(bootstrap).toMatch(
      /to_regprocedure\(\s*'public\.record_raw_seller_voice_transcription_outcome\(text,uuid,text\)'\s*\)[\s\S]*to_regprocedure\(\s*'private\.provider_usage_entries_coarse\(jsonb,text\[\],integer\)'\s*\)[\s\S]*to_regprocedure\(\s*'private\.fence_account_erasure_tenant_mutation\(\)'\s*\)/i,
    );
    expect(bootstrap).toMatch(
      /column_name = 'transcriptions'[\s\S]*trigger_name = 'retain_pipeline_seller_context'[\s\S]*trigger_name = 'zzz_fence_account_erasure_tenant_mutation'/i,
    );
    expect(bootstrap).toMatch(
      /errcode = '55000'[\s\S]*message = 'Issue 774 reconciliation prerequisites are missing'/i,
    );
  });

  it("fails closed unless the reconciled signatures grants RLS and triggers converge", () => {
    expect(reconciliationMigration).toMatch(
      /do \$reconciliation_postconditions\$[\s\S]*to_regprocedure\(\s*'public\.record_pipeline_run_voice_outcome\(uuid,uuid,text,boolean\)'\s*\)[\s\S]*to_regprocedure\(\s*'public\.record_pipeline_run_voice_outcome\(uuid,uuid,text\)'\s*\) is not null/i,
    );
    expect(reconciliationMigration).toMatch(
      /procedure\.prosecdef[\s\S]*procedure\.proconfig @> array\['search_path=""'\]::text\[\]/i,
    );
    expect(reconciliationMigration).toMatch(
      /not has_function_privilege\(\s*'service_role'[\s\S]*record_pipeline_run_provider_usage\(uuid,uuid,jsonb\)[\s\S]*has_function_privilege\(\s*'authenticated'[\s\S]*record_pipeline_run_provider_usage\(uuid,uuid,jsonb\)/i,
    );
    expect(reconciliationMigration).toMatch(
      /mobile_voice_terminal_provider_provenance_check[\s\S]*constraint_record\.convalidated[\s\S]*retain_pipeline_seller_context[\s\S]*zzz_fence_account_erasure_tenant_mutation[\s\S]*relation\.relrowsecurity/i,
    );
    expect(reconciliationMigration).toMatch(
      /errcode = '55000'[\s\S]*message = 'Issue 774 reconciliation did not converge'/i,
    );
  });

  it("replaces a same-named provenance constraint when its complete semantics differ", () => {
    const canonicalDefinitions = Array.from(
      reconciliationMigration.matchAll(
        /v_canonical_provenance_definition constant text := \$provenance_constraint\$([\s\S]*?)\$provenance_constraint\$/gi,
      ),
      ([, definition]) => definition.trim(),
    );
    const weakenedDefinition =
      "CHECK (terminal_voice_outcome IS NULL OR terminal_voice_outcome IN ('transcribed', 'empty', 'unsupported', 'timed-out', 'failed') OR transcription_provider_contacted IS NOT NULL)";

    expect(weakenedDefinition).toContain("terminal_voice_outcome");
    expect(weakenedDefinition).toContain("transcribed");
    expect(weakenedDefinition).toContain("unsupported");
    expect(weakenedDefinition).toContain("transcription_provider_contacted");
    expect(canonicalDefinitions).toHaveLength(2);
    expect(new Set(canonicalDefinitions).size).toBe(1);
    expect(canonicalDefinitions[0]).not.toBe(weakenedDefinition);
    expect(reconciliationMigration).toMatch(
      /select pg_get_constraintdef\(constraint_record\.oid, true\)[\s\S]*into v_existing_provenance_definition[\s\S]*if v_existing_provenance_definition is distinct from\s*v_canonical_provenance_definition then[\s\S]*drop constraint if exists mobile_voice_terminal_provider_provenance_check[\s\S]*add constraint mobile_voice_terminal_provider_provenance_check/i,
    );
    expect(reconciliationMigration).toMatch(
      /do \$reconciliation_postconditions\$[\s\S]*pg_get_constraintdef\(constraint_record\.oid, true\)\s*=\s*v_canonical_provenance_definition/i,
    );
    expect(reconciliationMigration).toMatch(
      /column_name = 'terminal_voice_outcome'[\s\S]*column_default is null[\s\S]*is_nullable = 'YES'[\s\S]*column_name = 'transcription_provider_contacted'[\s\S]*column_default is null[\s\S]*is_nullable = 'YES'/i,
    );
  });

  it("is replay-safe after either accepted schema without destructive or history DDL", () => {
    expect(reconciliationMigration).not.toMatch(
      /\b(?:drop|create)\s+table\b|\btruncate\b|\bdelete\s+from\b/i,
    );
    expect(reconciliationMigration).not.toMatch(
      /supabase_migrations|schema_migrations|migration repair/i,
    );
    expect(reconciliationMigration).not.toMatch(/\bcreate\s+trigger\b/i);
    expect(reconciliationMigration).not.toMatch(
      /add column(?!\s+if not exists)/i,
    );
    expect(reconciliationMigration).not.toMatch(
      /add column if not exists transcriptions/i,
    );
    expect(reconciliationMigration).not.toMatch(
      /create table private\.item_seller_voice_contexts/i,
    );
    expect(reconciliationMigration.match(/create or replace function/gi)).toHaveLength(
      5,
    );
  });

  it("fails pgTAP bootstrap closed until the reconciliation contract is installed", () => {
    expect(providerUsagePgtap).toMatch(
      /terminal_voice_outcome[\s\S]*transcription_provider_contacted[\s\S]*mobile_voice_terminal_provider_provenance_check/i,
    );
    expect(providerUsagePgtap).toMatch(
      /to_regprocedure\(\s*'public\.record_pipeline_run_voice_outcome\(uuid,uuid,text,boolean\)'\s*\) is not null[\s\S]*to_regprocedure\(\s*'public\.record_pipeline_run_voice_outcome\(uuid,uuid,text\)'\s*\) is null/i,
    );
    expect(providerUsagePgtap).toMatch(
      /requires the exact issue #774 reconciliation schema/i,
    );
  });

  it("records the exact clean-install stale-upgrade replay and live-suite lease plan", () => {
    expect(selectorAcceptanceMap).toMatch(
      /temporary database[\s\S]*20260811120000_durable_seller_voice_context\.sql[\s\S]*20260811123000_reconcile_durable_seller_voice_context\.sql/i,
    );
    expect(selectorAcceptanceMap).toMatch(
      /against the shared stale schema, apply only/i,
    );
    expect(selectorAcceptanceMap).toMatch(
      /20260811123000_reconcile_durable_seller_voice_context\.sql/i,
    );
    expect(selectorAcceptanceMap).toMatch(/second reconciliation\s+replay/i);
    expect(selectorAcceptanceMap).toMatch(/48\/48 pgTAP/i);
    expect(selectorAcceptanceMap).toMatch(
      /mobile-item-submission\.rls\.test\.ts[\s\S]*guest-recovery\.rls\.test\.ts[\s\S]*item-deletion\.rls\.test\.ts[\s\S]*account-erasure\.rls\.test\.ts[\s\S]*pipeline_run_provider_usage\.test\.sql/i,
    );
    expect(selectorAcceptanceMap).toMatch(
      /cleanup-source-parity\.test\.ts[\s\S]*exclusive-resource-lock\.test\.ts[\s\S]*credited-retention\.concurrency\.test\.ts/i,
    );
    expect(selectorAcceptanceMap).toMatch(
      /107 unique[\s\S]*zero residue[\s\S]*healthy/i,
    );
  });
});
