-- ---------------------------------------------------------------------------
-- Issue #1138 — a sold-comp usage row must say WHY it produced nothing.
--
-- Production recorded `apify: attempts 2, results 0` for an item eBay trades
-- every day. That row is equally consistent with a broken provider, a provider
-- whose candidates the matcher threw away, and an item with no comps, so the
-- defect could only be told apart from an honest miss by reading the provider's
-- own console. The row now carries `accepted` (what the provider-neutral matcher
-- kept) alongside `results` (what was fetched), plus a short `reason` drawn from
-- a closed vocabulary when the strategy contributed nothing.
--
-- No table, column, grant, policy, or RLS predicate changes here: the record is
-- stored in the existing `sold_comps` jsonb, so this migration only widens the
-- two private helpers that validate and merge it. Tenant isolation is exactly
-- what it was, which `sold-comp-usage-reasons.rls.test.ts` asserts rather than
-- assumes.
--
-- Expand, not break: both helpers accept the pre-#1138 entry shape, so a run
-- queued before this deploy still records its cost after it.
-- ---------------------------------------------------------------------------

create or replace function private.provider_usage_record_is_strict(p_usage jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_models jsonb;
  v_transcriptions jsonb;
  v_sold_comps jsonb;
begin
  if jsonb_typeof(p_usage) is distinct from 'object'
    or octet_length(p_usage::text) > 65536
    or not p_usage ?& array[
      'schemaVersion', 'modelCalls', 'inputTokens', 'cachedInputTokens',
      'outputTokens', 'reasoningTokens', 'models', 'soldComps'
    ]
    or p_usage - array[
      'schemaVersion', 'modelCalls', 'inputTokens', 'cachedInputTokens',
      'outputTokens', 'reasoningTokens', 'models', 'transcriptions',
      'soldComps'
    ] <> '{}'::jsonb
    or p_usage->'schemaVersion' is distinct from '1'::jsonb
    or not private.provider_usage_nonnegative_integer(
      p_usage->'modelCalls', 2147483647
    )
    or not private.provider_usage_nonnegative_integer(
      p_usage->'inputTokens', 9223372036854775807
    )
    or not private.provider_usage_nonnegative_integer(
      p_usage->'cachedInputTokens', 9223372036854775807
    )
    or not private.provider_usage_nonnegative_integer(
      p_usage->'outputTokens', 9223372036854775807
    )
    or not private.provider_usage_nonnegative_integer(
      p_usage->'reasoningTokens', 9223372036854775807
    ) then
    return false;
  end if;

  v_models := p_usage->'models';
  v_transcriptions := coalesce(p_usage->'transcriptions', '[]'::jsonb);
  v_sold_comps := p_usage->'soldComps';
  if jsonb_typeof(v_models) is distinct from 'array'
    or jsonb_array_length(v_models) > 64
    or jsonb_typeof(v_transcriptions) is distinct from 'array'
    or jsonb_array_length(v_transcriptions) > 16
    or jsonb_typeof(v_sold_comps) is distinct from 'array'
    or jsonb_array_length(v_sold_comps) > 16 then
    return false;
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_models) entry
    where jsonb_typeof(entry) is distinct from 'object'
      or not entry ?& array[
        'role', 'provider', 'model', 'calls', 'inputTokens',
        'cachedInputTokens', 'outputTokens', 'reasoningTokens'
      ]
      or entry - array[
        'role', 'provider', 'model', 'calls', 'inputTokens',
        'cachedInputTokens', 'outputTokens', 'reasoningTokens'
      ] <> '{}'::jsonb
      or jsonb_typeof(entry->'role') is distinct from 'string'
      or entry->>'role' not in (
        'vision', 'listing', 'export', 'pricingAgent', 'judge'
      )
      or jsonb_typeof(entry->'provider') is distinct from 'string'
      or entry->>'provider' not in ('openai', 'google')
      or jsonb_typeof(entry->'model') is distinct from 'string'
      or octet_length(entry->>'model') not between 1 and 200
      or not private.provider_usage_nonnegative_integer(
        entry->'calls', 2147483647
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'inputTokens', 9223372036854775807
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'cachedInputTokens', 9223372036854775807
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'outputTokens', 9223372036854775807
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'reasoningTokens', 9223372036854775807
      )
  ) then
    return false;
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_transcriptions) entry
    where jsonb_typeof(entry) is distinct from 'object'
      or not entry ?& array[
        'role', 'provider', 'model', 'calls', 'chargedUsd'
      ]
      or entry - array[
        'role', 'provider', 'model', 'calls', 'chargedUsd'
      ] <> '{}'::jsonb
      or entry->'role' is distinct from '"sellerContext"'::jsonb
      or jsonb_typeof(entry->'provider') is distinct from 'string'
      or entry->>'provider' not in ('openai', 'google')
      or jsonb_typeof(entry->'model') is distinct from 'string'
      or octet_length(entry->>'model') not between 1 and 200
      or not private.provider_usage_nonnegative_integer(
        entry->'calls', 2147483647
      )
      or jsonb_typeof(entry->'chargedUsd') is distinct from 'null'
  ) then
    return false;
  end if;

  -- #1138: `accepted` and `reason` are OPTIONAL here. The writer always sends
  -- them, but a run queued before the deploy is replayed against this function
  -- after it, and refusing that payload would throw away a whole run's cost
  -- record over two telemetry fields. Present-and-wrong is still refused.
  if exists (
    select 1 from jsonb_array_elements(v_sold_comps) entry
    where jsonb_typeof(entry) is distinct from 'object'
      or not entry ?& array['strategy', 'attempts', 'results', 'chargedUsd']
      or entry - array[
        'strategy', 'attempts', 'results', 'accepted', 'reason', 'chargedUsd'
      ] <> '{}'::jsonb
      or (
        entry ? 'accepted'
        and not private.provider_usage_nonnegative_integer(
          entry->'accepted', 2147483647
        )
      )
      or (
        entry ? 'reason'
        and jsonb_typeof(entry->'reason') is distinct from 'null'
        and (
          jsonb_typeof(entry->'reason') is distinct from 'string'
          -- The same closed vocabulary `isSoldCompUsageReason` enforces in TS.
          or (
            entry->>'reason' not in ('no-candidates', 'provider-error', 'blocked')
            and entry->>'reason' !~ '^all-rejected:[a-z][a-z-]{0,39}$'
          )
        )
      )
      or jsonb_typeof(entry->'strategy') is distinct from 'string'
      or octet_length(entry->>'strategy') not between 1 and 64
      or not private.provider_usage_nonnegative_integer(
        entry->'attempts', 2147483647
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'results', 2147483647
      )
      or (
        jsonb_typeof(entry->'chargedUsd') is distinct from 'null'
        and not private.provider_usage_nonnegative_decimal(
          entry->'chargedUsd', 999999.999999
        )
      )
  ) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function private.provider_usage_record_is_strict(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.provider_usage_merge_sold_comps(
  p_existing jsonb,
  p_incoming jsonb
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'strategy', merged.strategy,
        'attempts', merged.attempts,
        'results', merged.results,
        'accepted', merged.accepted,
        -- #1138: a reason describes an EMPTY contribution, so a strategy that
        -- anchored anywhere in the merged history reports none. Same invariant
        -- the in-process tally holds, so a row means the same thing whether it
        -- was written in one pass or topped up by a correction.
        'reason', case
          when merged.accepted > 0 then null
          else merged.reasons[cardinality(merged.reasons)]
        end,
        'chargedUsd', merged.charged_usd
      )
      order by merged.strategy
    ),
    '[]'::jsonb
  )
  from (
    select
      entry->>'strategy' as strategy,
      sum((entry->>'attempts')::numeric) as attempts,
      sum((entry->>'results')::numeric) as results,
      -- A pre-#1138 entry carries no 'accepted'; ->> gives NULL, sum() skips it,
      -- and the strategy reads as zero accepted rather than failing the merge.
      coalesce(sum((entry->>'accepted')::numeric), 0) as accepted,
      -- `||` appends the incoming array AFTER the stored one, so ordinality is
      -- write order and the last non-null reason is the most recent one.
      array_remove(array_agg(entry->>'reason' order by entry_index), null) as reasons,
      -- sum() ignores SQL NULLs and returns NULL when every input is one, which
      -- is exactly the null-preserving rule the table documents: a strategy that
      -- reported no charge stays unknown rather than becoming zero.
      sum((entry->>'chargedUsd')::numeric) as charged_usd
    from jsonb_array_elements(
      coalesce(p_existing, '[]'::jsonb) || coalesce(p_incoming, '[]'::jsonb)
    ) with ordinality as t(entry, entry_index)
    group by 1
  ) merged;
$$;

revoke all on function private.provider_usage_merge_sold_comps(jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.provider_usage_initial_snapshot_is_strict(
  p_snapshot jsonb
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_typeof(p_snapshot) = 'object'
    and p_snapshot - array[
      'modelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens',
      'reasoningTokens', 'soldCompAttempts', 'soldCompResults',
      'soldCompChargedUsd', 'models', 'transcriptions', 'soldComps'
    ] = '{}'::jsonb
    and p_snapshot ?& array[
      'modelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens',
      'reasoningTokens', 'soldCompAttempts', 'soldCompResults',
      'soldCompChargedUsd', 'models', 'transcriptions', 'soldComps'
    ]
    and private.provider_usage_entries_coarse(
      p_snapshot->'models',
      array[
        'role', 'provider', 'model', 'calls', 'inputTokens',
        'cachedInputTokens', 'outputTokens', 'reasoningTokens'
      ],
      64
    )
    and private.provider_usage_entries_coarse(
      p_snapshot->'transcriptions',
      array['role', 'provider', 'model', 'calls', 'chargedUsd'],
      16
    )
    -- #1138 widened the sold-comp entry with 'accepted' and 'reason'. The
    -- snapshot is a COPY of a stored row, so its allowlist has to move with the
    -- column's, or the first guided correction on a post-#1138 row would fail
    -- its own snapshot check and lose the seller nothing but their cost history.
    and private.provider_usage_entries_coarse(
      p_snapshot->'soldComps',
      array['strategy', 'attempts', 'results', 'accepted', 'reason', 'chargedUsd'],
      16
    );
$$;

revoke all on function private.provider_usage_initial_snapshot_is_strict(jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The column's own coarse key allowlist. Dropped and re-added rather than
-- widened in place because a CHECK has no ALTER: the re-add validates every
-- stored row, which passes because the allowlist only GREW. Nothing about the
-- table's ownership, grants, or policies is touched.
-- ---------------------------------------------------------------------------
alter table public.pipeline_run_provider_usage
  drop constraint if exists pipeline_run_provider_usage_sold_comps_check;

alter table public.pipeline_run_provider_usage
  add constraint pipeline_run_provider_usage_sold_comps_check check (
    private.provider_usage_entries_coarse(
      sold_comps,
      array['strategy', 'attempts', 'results', 'accepted', 'reason', 'chargedUsd'],
      16
    )
  );
