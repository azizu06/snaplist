-- Preserve the established guided-correction authority error ordering while
-- keeping the bounded current-write evidence validator outside the legacy
-- implementation. This precheck is diagnostic only: the private implementation
-- still locks and revalidates the capability immediately before mutation.

create or replace function public.complete_guided_review_correction(
  p_completion_token text,
  p_commit jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap private.guided_correction_completion_capabilities%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Guided correction completion authorization is required';
  end if;
  if p_completion_token !~ '^[A-Za-z0-9_-]{43}$'
    or jsonb_typeof(p_commit) is distinct from 'object'
    or octet_length(p_commit::text) > 524288 then
    raise exception using
      errcode = '22023',
      message = 'Invalid guided correction completion';
  end if;

  select * into v_cap
  from private.guided_correction_completion_capabilities capability
  where capability.token_hash = encode(
    sha256(convert_to(p_completion_token, 'UTF8')), 'hex'
  );
  if not found or v_cap.consumed_at is not null or v_cap.expires_at <= v_now then
    raise exception using
      errcode = 'P0001',
      message = 'Guided correction capability is unavailable';
  end if;
  if p_commit->>'item_id' is distinct from v_cap.item_id::text
    or p_commit->>'listing_id' is distinct from v_cap.listing_id::text
    or p_commit->>'run_id' is distinct from v_cap.completion_run_id::text
    or p_commit->>'expected_run_id' is distinct from v_cap.expected_run_id::text
    or p_commit->>'expected_review_revision'
      is distinct from v_cap.expected_review_revision::text then
    raise exception using
      errcode = '42501',
      message = 'Guided correction capability binding mismatch';
  end if;

  if not private.pricing_evidence_rows_current_write(
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
