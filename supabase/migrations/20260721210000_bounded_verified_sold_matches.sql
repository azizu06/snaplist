-- Issue #361: one immutable pricing snapshot retains at most the five verified
-- sold matches selected by the canonical matcher. Existing historical rows are
-- not rewritten; every new pipeline or guided-correction completion reuses this
-- function through the existing table check and completion RPC validation.

create or replace function private.pricing_evidence_rows_coarse(p_evidence jsonb)
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

revoke all on function private.pricing_evidence_rows_coarse(jsonb)
  from public, anon, authenticated, service_role;
