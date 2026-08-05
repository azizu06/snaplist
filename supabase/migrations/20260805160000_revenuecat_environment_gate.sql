-- Issue #679: bind RevenueCat delivery environment to verification and replay
-- identity. Historical rows predate the boundary and remain honestly marked
-- instead of being guessed as sandbox or production.
--
-- Design choice: SANDBOX deliveries remain testable through the signed,
-- environment-bound audit path, but this RPC never forwards them into the
-- shared StoreKit allowance ledger. That ledger has no deployment-environment
-- selector, so persisting an active sandbox period there would make it
-- production-selectable. Only a fresh PRODUCTION event may create or reactivate
-- RevenueCat-backed allowance state.

alter table private.revenuecat_webhook_events
  add column environment text;

update private.revenuecat_webhook_events
set environment = 'LEGACY_UNKNOWN'
where environment is null;

alter table private.revenuecat_webhook_events
  alter column environment set not null,
  add constraint revenuecat_webhook_events_environment_check
    check (environment in ('PRODUCTION', 'SANDBOX', 'LEGACY_UNKNOWN')),
  drop constraint revenuecat_webhook_events_outcome_check,
  add constraint revenuecat_webhook_events_outcome_check check (outcome in (
    'applied', 'duplicate', 'reconciliation_required',
    'unmapped_reconciliation', 'sandbox_ignored'
  )),
  drop constraint revenuecat_webhook_events_pkey,
  add primary key (environment, event_id);

comment on column private.revenuecat_webhook_events.environment is
  'Signed RevenueCat event environment. LEGACY_UNKNOWN is reserved for rows persisted before issue #679.';

create or replace function private.quarantine_legacy_revenuecat_allowances()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quarantined integer;
begin
  update public.ai_item_allowance_periods period
  set state = 'ambiguous',
      grace_expires_date = null,
      updated_at = statement_timestamp()
  where period.source = 'storekit'
    and period.state in ('active', 'grace')
    and exists (
      select 1
      from private.revenuecat_webhook_events event
      where event.environment = 'LEGACY_UNKNOWN'
        and event.user_id = period.user_id
        and event.original_transaction_id = period.original_transaction_id
        and event.event_id = period.last_event_id
    );
  get diagnostics v_quarantined = row_count;
  return v_quarantined;
end;
$$;

comment on function private.quarantine_legacy_revenuecat_allowances() is
  'Issue #679 upgrade seam: active/grace StoreKit periods whose last authority is an environment-unknown RevenueCat event become ambiguous until a fresh PRODUCTION event verifies them.';
revoke all on function private.quarantine_legacy_revenuecat_allowances()
  from public, anon, authenticated, service_role;

select private.quarantine_legacy_revenuecat_allowances();

drop function public.record_verified_revenuecat_ai_item_period(
  text, text, text, text, timestamptz, timestamptz, text, timestamptz,
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
  p_event_created_at timestamptz
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
  if v_transition_state = 'required' then
    raise exception using errcode = '23514', message = 'Billing-source reconciliation is required';
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

  if p_environment = 'SANDBOX' then
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

drop function public.require_revenuecat_reconciliation(
  text, text, text, text, text, timestamptz
);

create function public.require_revenuecat_reconciliation(
  p_revenuecat_app_user_id text,
  p_original_app_user_id text,
  p_original_transaction_id text,
  p_environment text,
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_app_binding public.revenuecat_customer_bindings%rowtype;
  v_transaction_binding public.revenuecat_customer_bindings%rowtype;
  v_app_found boolean;
  v_transaction_found boolean;
  v_fingerprint text := md5(jsonb_build_object(
    'app_user_id', p_revenuecat_app_user_id,
    'original_app_user_id', p_original_app_user_id,
    'original_transaction_id', p_original_transaction_id,
    'environment', p_environment,
    'event_id', p_event_id,
    'event_type', p_event_type,
    'event_created_at', p_event_created_at
  )::text);
  v_existing private.revenuecat_webhook_events%rowtype;
  v_effective_event_created_at timestamptz;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'RevenueCat reconciliation authorization is required';
  end if;
  if p_environment is null or p_environment not in ('PRODUCTION', 'SANDBOX') then
    raise exception using errcode = '22023', message = 'Invalid RevenueCat environment';
  end if;
  if coalesce(char_length(p_revenuecat_app_user_id), 0) not between 1 and 255
    or coalesce(char_length(p_original_app_user_id), 0) not between 1 and 255
    or coalesce(char_length(p_original_transaction_id), 0) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Invalid RevenueCat reconciliation identity';
  end if;
  if p_original_app_user_id is distinct from p_revenuecat_app_user_id then
    raise exception using errcode = '23514', message = 'RevenueCat original App User ID conflicts with the customer binding';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('revenuecat-transaction:' || p_original_transaction_id, 0)
  );

  select * into v_existing
  from private.revenuecat_webhook_events event
  where event.environment = p_environment
    and event.event_id = p_event_id
  for update;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint then
      raise exception using errcode = '23514', message = 'RevenueCat reconciliation event identity conflicts';
    end if;
    return false;
  end if;

  select * into v_app_binding
  from public.revenuecat_customer_bindings binding
  where binding.revenuecat_app_user_id = p_revenuecat_app_user_id
  for update;
  v_app_found := found;

  select * into v_transaction_binding
  from public.revenuecat_customer_bindings binding
  where binding.original_transaction_id = p_original_transaction_id
  for update;
  v_transaction_found := found;

  if v_app_found and v_transaction_found
    and v_app_binding.user_id <> v_transaction_binding.user_id then
    raise exception using errcode = '23514', message = 'RevenueCat reconciliation identity crosses tenant bindings';
  end if;
  if v_app_found
    and v_app_binding.original_transaction_id is not null
    and v_app_binding.original_transaction_id <> p_original_transaction_id then
    raise exception using errcode = '23514', message = 'RevenueCat reconciliation transaction conflicts with the customer binding';
  end if;
  if v_transaction_found
    and v_transaction_binding.revenuecat_app_user_id <> p_revenuecat_app_user_id then
    raise exception using errcode = '23514', message = 'RevenueCat reconciliation customer conflicts with the transaction binding';
  end if;

  v_user_id := case
    when v_app_found then v_app_binding.user_id
    when v_transaction_found then v_transaction_binding.user_id
    else null
  end;

  if v_user_id is not null then
    v_effective_event_created_at := greatest(
      p_event_created_at,
      statement_timestamp(),
      coalesce(
        v_app_binding.last_event_created_at + interval '1 microsecond',
        p_event_created_at
      ),
      coalesce(
        v_transaction_binding.last_event_created_at + interval '1 microsecond',
        p_event_created_at
      )
    );
    update public.revenuecat_customer_bindings
    set transition_state = 'required',
        lifecycle_state = 'ambiguous',
        last_event_id = p_event_id,
        last_event_type = p_event_type,
        last_event_created_at = v_effective_event_created_at,
        updated_at = statement_timestamp()
    where user_id = v_user_id;
  end if;

  insert into private.revenuecat_webhook_events (
    environment, event_id, user_id, revenuecat_app_user_id,
    original_transaction_id, event_type, event_created_at,
    payload_fingerprint, outcome
  ) values (
    p_environment, p_event_id, v_user_id, p_revenuecat_app_user_id,
    p_original_transaction_id, p_event_type, p_event_created_at,
    v_fingerprint, case when v_user_id is null
      then 'unmapped_reconciliation'
      else 'reconciliation_required'
    end
  );
  return true;
end;
$$;

revoke all on function public.record_verified_revenuecat_ai_item_period(
  text, text, text, text, text, timestamptz, timestamptz, text, timestamptz,
  integer, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.require_revenuecat_reconciliation(
  text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.record_verified_revenuecat_ai_item_period(
  text, text, text, text, text, timestamptz, timestamptz, text, timestamptz,
  integer, text, text, timestamptz
) to service_role;
grant execute on function public.require_revenuecat_reconciliation(
  text, text, text, text, text, text, timestamptz
) to service_role;
