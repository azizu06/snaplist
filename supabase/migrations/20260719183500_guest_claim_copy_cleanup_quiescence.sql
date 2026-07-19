-- Issue #268: quiesce an expired claim-copy writer before returning its
-- terminal outcome. This migration is intentionally later than #175 so a
-- database that already applied the frozen parent migration receives the RPC
-- signature and idempotency-fence upgrade.

revoke all on function public.queue_guest_claim_copy_cleanup(
  uuid, text, text, uuid
) from public, anon, authenticated, service_role;
drop function public.queue_guest_claim_copy_cleanup(uuid, text, text, uuid);

create or replace function public.queue_guest_claim_copy_cleanup(
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_idempotency_key uuid,
  p_claim_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$'
    or p_idempotency_key is null
    or p_claim_lease_token is null then
    raise exception using errcode = '22023', message = 'Invalid guest cleanup request';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.recovery_token_hash = p_recovery_token_hash
    and recovery.claim_idempotency_user_id = p_target_user_id
    and recovery.claim_idempotency_key = p_idempotency_key
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  return private.queue_guest_claim_copy_cleanup(
    v_recovery,
    p_target_user_id,
    p_claim_lease_token,
    true
  );
end;
$$;

revoke all on function public.queue_guest_claim_copy_cleanup(
  uuid, text, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.queue_guest_claim_copy_cleanup(
  uuid, text, text, uuid, uuid
) to service_role;
