-- Issue #366: preserve immutable V1 pricing-evidence rows through schema-first
-- restore while keeping the #361 five-record bound on current completion writes.

-- This function is part of the historical table contract. Replacing its body
-- with the #361 write policy changed the meaning of the existing CHECK in place,
-- so restore the original V1 allowance without rewriting or truncating rows.
create or replace function private.pricing_evidence_rows_coarse(p_evidence jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_evidence) is distinct from 'array'
    or jsonb_array_length(p_evidence) > 60
    or octet_length(p_evidence::text) > 131072 then
    return false;
  end if;
  return not exists (
    select 1 from jsonb_array_elements(p_evidence) row_value
    where jsonb_typeof(row_value) is distinct from 'object'
  );
end;
$$;

revoke all on function private.pricing_evidence_rows_coarse(jsonb)
  from public, anon, authenticated, service_role;

-- Current writes keep a separate policy validator. This versions write
-- authority without changing the immutable V1 row schema or its table CHECK.
create or replace function private.pricing_evidence_rows_current_write(
  p_evidence jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_evidence) is distinct from 'array'
    or jsonb_array_length(p_evidence) > 5
    or octet_length(p_evidence::text) > 131072 then
    return false;
  end if;
  return not exists (
    select 1 from jsonb_array_elements(p_evidence) row_value
    where jsonb_typeof(row_value) is distinct from 'object'
  );
end;
$$;

revoke all on function private.pricing_evidence_rows_current_write(jsonb)
  from public, anon, authenticated, service_role;

-- Preserve the existing completion implementations as private delegates. They
-- retain the full legacy-compatible V1 validator while the stable public RPCs
-- below apply the current five-record policy before any durable mutation.
alter function public.complete_pipeline_run(uuid, uuid, jsonb)
  set schema private;
alter function private.complete_pipeline_run(uuid, uuid, jsonb)
  rename to complete_pipeline_run_legacy_evidence_v1;

revoke all on function private.complete_pipeline_run_legacy_evidence_v1(
  uuid, uuid, jsonb
) from public, anon, authenticated, service_role;

create function public.complete_pipeline_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_persistence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline worker authorization is required';
  end if;
  if jsonb_typeof(p_persistence) is distinct from 'object'
    or not private.pricing_evidence_rows_current_write(
      p_persistence #> '{pricing_snapshot,evidence}'
    ) then
    raise exception using
      errcode = '22023',
      message = 'Invalid pricing evidence snapshot';
  end if;

  return private.complete_pipeline_run_legacy_evidence_v1(
    p_run_id,
    p_lease_token,
    p_persistence
  );
end;
$$;

revoke all on function public.complete_pipeline_run(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_pipeline_run(uuid, uuid, jsonb)
  to service_role;

alter function public.complete_guided_review_correction(text, jsonb)
  set schema private;
alter function private.complete_guided_review_correction(text, jsonb)
  rename to complete_guided_review_correction_legacy_evidence_v1;

revoke all on function private.complete_guided_review_correction_legacy_evidence_v1(
  text, jsonb
) from public, anon, authenticated, service_role;

create function public.complete_guided_review_correction(
  p_completion_token text,
  p_commit jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Guided correction completion authorization is required';
  end if;
  if jsonb_typeof(p_commit) is distinct from 'object'
    or not private.pricing_evidence_rows_current_write(
      p_commit #> '{pricing_snapshot,evidence}'
    ) then
    raise exception using
      errcode = '22023',
      message = 'Invalid guided correction completion';
  end if;

  return private.complete_guided_review_correction_legacy_evidence_v1(
    p_completion_token,
    p_commit
  );
end;
$$;

revoke all on function public.complete_guided_review_correction(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_guided_review_correction(text, jsonb)
  to service_role;
