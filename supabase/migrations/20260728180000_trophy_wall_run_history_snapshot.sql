-- Issue #375: make Trophy Wall run-history continuation stable while current
-- pipeline_runs rows keep advancing.
--
-- A cursor freezes membership and ordering at the latest committed ordering
-- revision visible to its tenant. Canonical run detail is still read from the
-- current pipeline_runs row by the existing mobile adapter.

create table public.pipeline_run_history_order_versions (
  revision bigint generated always as identity primary key,
  run_id uuid not null
    references public.pipeline_runs (id)
    on delete cascade,
  user_id text not null,
  last_meaningful_update_at timestamptz not null,
  recorded_at timestamptz not null default statement_timestamp()
);

comment on table public.pipeline_run_history_order_versions is
  'Append-only tenant ordering versions for snapshot-stable Trophy Wall pagination.';
comment on column public.pipeline_run_history_order_versions.last_meaningful_update_at is
  'The canonical pipeline_runs.updated_at ordering value at this committed version.';

create index pipeline_run_history_order_versions_user_revision_idx
  on public.pipeline_run_history_order_versions (user_id, revision desc);

create index pipeline_run_history_order_versions_user_run_revision_idx
  on public.pipeline_run_history_order_versions (
    user_id,
    run_id,
    revision desc
  );

alter table public.pipeline_run_history_order_versions enable row level security;

revoke all on table public.pipeline_run_history_order_versions
  from public, anon, authenticated, service_role;
revoke all on sequence public.pipeline_run_history_order_versions_revision_seq
  from public, anon, authenticated, service_role;
grant select on table public.pipeline_run_history_order_versions
  to authenticated;

create policy pipeline_run_history_order_versions_select_own
  on public.pipeline_run_history_order_versions
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create or replace function private.record_pipeline_run_history_order_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_user text;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      -- Guest claim already serializes and transfers the owning run in one
      -- transaction. Take both tenant history locks in stable order before
      -- moving every frozen version with that same run.
      for v_lock_user in
        select value
        from unnest(array[old.user_id, new.user_id]) value
        order by value
      loop
        perform pg_advisory_xact_lock(
          hashtextextended('trophy-run-order:' || v_lock_user, 0)
        );
      end loop;

      update public.pipeline_run_history_order_versions
      set user_id = new.user_id
      where run_id = new.id
        and user_id = old.user_id;
    elsif new.updated_at is not distinct from old.updated_at then
      return new;
    end if;
  end if;

  if tg_op <> 'UPDATE'
    or new.user_id is not distinct from old.user_id then
    -- Sequence allocation alone does not define commit order. Serializing only
    -- this tenant's ordering writes ensures a visible max(revision) is a safe
    -- snapshot frontier even when another run update is still in flight.
    perform pg_advisory_xact_lock(
      hashtextextended('trophy-run-order:' || new.user_id, 0)
    );
  end if;

  if tg_op = 'UPDATE'
    and new.updated_at is not distinct from old.updated_at then
    return new;
  end if;

  insert into public.pipeline_run_history_order_versions (
    run_id,
    user_id,
    last_meaningful_update_at
  )
  values (
    new.id,
    new.user_id,
    new.updated_at
  );

  return new;
end;
$$;

revoke all on function private.record_pipeline_run_history_order_version()
  from public, anon, authenticated, service_role;

-- Keep the backfill and trigger installation atomic with respect to run
-- inserts/updates, so every durable run has exactly one committed frontier
-- before post-migration versions can be recorded.
begin;

lock table public.pipeline_runs in share row exclusive mode;

insert into public.pipeline_run_history_order_versions (
  run_id,
  user_id,
  last_meaningful_update_at
)
select
  run.id,
  run.user_id,
  run.updated_at
from public.pipeline_runs as run;

create trigger pipeline_runs_record_history_order_version
  after insert or update on public.pipeline_runs
  for each row
  execute function private.record_pipeline_run_history_order_version();

commit;

create or replace function public.list_mobile_run_history_page(
  p_limit integer,
  p_snapshot_revision text default null,
  p_before_updated_at timestamptz default null,
  p_before_run_id uuid default null
)
returns table (
  run_id uuid,
  logical_idempotency_key text,
  last_meaningful_update_at timestamptz,
  snapshot_revision text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_current_revision bigint;
  v_snapshot_revision bigint;
begin
  if v_user_id is null or btrim(v_user_id) = '' then
    raise exception using
      errcode = '42501',
      message = 'Authenticated run-history identity is required';
  end if;

  if p_limit is null or p_limit not between 1 and 51 then
    raise exception using
      errcode = '22023',
      message = 'Run-history page limit must be between 1 and 51';
  end if;

  if (p_before_updated_at is null) <> (p_before_run_id is null)
    or (
      p_snapshot_revision is null
      and (p_before_updated_at is not null or p_before_run_id is not null)
    ) then
    raise exception using
      errcode = '22023',
      message = 'Run-history cursor components must be complete';
  end if;

  select max(version.revision)
  into v_current_revision
  from public.pipeline_run_history_order_versions as version
  where version.user_id = v_user_id;

  if v_current_revision is null then
    return;
  end if;

  if p_snapshot_revision is null then
    v_snapshot_revision := v_current_revision;
  else
    if p_snapshot_revision !~ '^[1-9][0-9]*$' then
      raise exception using
        errcode = '22023',
        message = 'Run-history snapshot revision is invalid';
    end if;
    v_snapshot_revision := p_snapshot_revision::bigint;
    if v_snapshot_revision > v_current_revision then
      raise exception using
        errcode = '22023',
        message = 'Run-history snapshot revision is unavailable';
    end if;
  end if;

  return query
  with frozen_run_order as materialized (
    select distinct on (version.run_id)
      version.run_id,
      version.last_meaningful_update_at
    from public.pipeline_run_history_order_versions as version
    where version.user_id = v_user_id
      and version.revision <= v_snapshot_revision
    order by version.run_id, version.revision desc
  )
  select
    frozen.run_id,
    run.idempotency_key,
    frozen.last_meaningful_update_at,
    v_snapshot_revision::text
  from frozen_run_order as frozen
  join public.pipeline_runs as run
    on run.id = frozen.run_id
   and run.user_id = v_user_id
  where p_before_updated_at is null
    or frozen.last_meaningful_update_at < p_before_updated_at
    or (
      frozen.last_meaningful_update_at = p_before_updated_at
      and frozen.run_id < p_before_run_id
    )
  order by frozen.last_meaningful_update_at desc, frozen.run_id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_mobile_run_history_page(
  integer,
  text,
  timestamptz,
  uuid
) from public, anon, service_role;
grant execute on function public.list_mobile_run_history_page(
  integer,
  text,
  timestamptz,
  uuid
) to authenticated;
