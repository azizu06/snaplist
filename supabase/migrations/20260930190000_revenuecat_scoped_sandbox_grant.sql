-- Scoped Apple sandbox grants for allowlisted test accounts.
--
-- #679 made every SANDBOX RevenueCat delivery audit-only (`sandbox_ignored`), so
-- a genuine signed sandbox purchase could never be proved end to end: the
-- receipt, webhook and verification all succeeded, and the seller still saw no
-- Pro and no credits. The webhook now decides, from the server-only
-- REVENUECAT_SANDBOX_GRANT_USER_IDS allowlist of exact Clerk ids, whether a
-- signature-verified SANDBOX event belongs to a test account, and passes that
-- decision as `p_sandbox_grant`.
--
-- The flag defaults to false, so this migration is behavior-preserving until the
-- webhook sends it: ordinary sellers keep the #679 audit-only outcome, the
-- reconciliation RPC is unchanged, and PRODUCTION events follow the same path
-- as before. A granted SANDBOX event is persisted with its own environment in
-- the event key and audit row, exactly like a PRODUCTION event.

drop function public.record_verified_revenuecat_ai_item_period(
  text, text, text, text, text, timestamptz, timestamptz, text, timestamptz,
  integer, text, text, timestamptz
);

create function public.record_verified_revenuecat_ai_item_period(
  p_user_id text,
  p_revenuecat_app_user_id text,
  p_environment text,
  p_period_key text,
  p_original_transaction_id text,
  p_period_start timestamptz,
  p_expires_date timestamptz,
  p_state text,
  p_grace_expires_date timestamptz,
  p_allowance integer,
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_sandbox_grant boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fingerprint text;
  v_existing private.revenuecat_webhook_events%rowtype;
  v_applied boolean;
  v_transition_state text;
  v_storekit_event_id text := lower(p_environment) || ':' || md5(p_event_id);
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'RevenueCat period authorization is required';
  end if;
  if p_environment is null or p_environment not in ('PRODUCTION', 'SANDBOX') then
    raise exception using errcode = '22023', message = 'Invalid RevenueCat environment';
  end if;
  v_fingerprint := md5(jsonb_build_object(
    'user_id', p_user_id,
    'app_user_id', p_revenuecat_app_user_id,
    'environment', p_environment,
    'period_key', p_period_key,
    'original_transaction_id', p_original_transaction_id,
    'period_start', p_period_start,
    'expires_date', p_expires_date,
    'state', p_state,
    'grace_expires_date', p_grace_expires_date,
    'allowance', p_allowance,
    'event_type', p_event_type,
    'event_created_at', p_event_created_at
  )::text);

  perform pg_advisory_xact_lock(
    hashtextextended('revenuecat-customer:' || p_user_id, 0)
  );
  select binding.transition_state into v_transition_state
  from public.revenuecat_customer_bindings binding
  where binding.user_id = p_user_id
    and binding.revenuecat_app_user_id = p_revenuecat_app_user_id
    and binding.original_transaction_id = p_original_transaction_id
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'RevenueCat customer binding does not match the verified period';
  end if;
  select * into v_existing
  from private.revenuecat_webhook_events event
  where event.environment = p_environment
    and event.event_id = p_event_id
  for update;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint then
      raise exception using errcode = '23514', message = 'RevenueCat event identity conflicts';
    end if;
    return false;
  end if;

  -- Only the webhook's scoped test-account grant lets a SANDBOX event past
  -- this audit-only branch; every other SANDBOX delivery stays ignored.
  if p_environment = 'SANDBOX' and not coalesce(p_sandbox_grant, false) then
    insert into private.revenuecat_webhook_events (
      environment, event_id, user_id, revenuecat_app_user_id,
      original_transaction_id, event_type, event_created_at,
      payload_fingerprint, outcome
    ) values (
      p_environment, p_event_id, p_user_id, p_revenuecat_app_user_id,
      p_original_transaction_id, p_event_type, p_event_created_at,
      v_fingerprint, 'sandbox_ignored'
    );
    return false;
  end if;

  if v_transition_state = 'required' then
    raise exception using errcode = '23514', message = 'Billing-source reconciliation is required';
  end if;

  v_applied := public.record_verified_storekit_ai_item_period(
    p_user_id,
    p_period_key,
    p_original_transaction_id,
    p_period_start,
    p_expires_date,
    p_state,
    p_grace_expires_date,
    p_allowance,
    v_storekit_event_id,
    p_event_created_at
  );

  insert into private.revenuecat_webhook_events (
    environment, event_id, user_id, revenuecat_app_user_id,
    original_transaction_id, event_type, event_created_at,
    payload_fingerprint, outcome
  ) values (
    p_environment, p_event_id, p_user_id, p_revenuecat_app_user_id,
    p_original_transaction_id, p_event_type, p_event_created_at,
    v_fingerprint, case when v_applied then 'applied' else 'duplicate' end
  );

  update public.revenuecat_customer_bindings
  set lifecycle_state = p_state,
      renewal_state = case
        when p_event_type = 'CANCELLATION' then 'canceled'
        when p_state in ('active', 'grace') then 'renewing'
        else renewal_state
      end,
      last_event_id = p_event_id,
      last_event_type = p_event_type,
      last_event_created_at = p_event_created_at,
      updated_at = statement_timestamp()
  where user_id = p_user_id
    and (
      last_event_created_at is null
      or last_event_created_at < p_event_created_at
    );
  return v_applied;
end;
$$;

revoke all on function public.record_verified_revenuecat_ai_item_period(
  text, text, text, text, text, timestamptz, timestamptz, text, timestamptz,
  integer, text, text, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.record_verified_revenuecat_ai_item_period(
  text, text, text, text, text, timestamptz, timestamptz, text, timestamptz,
  integer, text, text, timestamptz, boolean
) to service_role;
