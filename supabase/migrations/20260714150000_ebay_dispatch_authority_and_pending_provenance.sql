alter table private.ebay_provider_dispatch_leases
  add column if not exists attempt_token uuid;

update private.ebay_provider_dispatch_leases
set attempt_token = gen_random_uuid()
where attempt_token is null;

alter table private.ebay_provider_dispatch_leases
  alter column attempt_token set default gen_random_uuid(),
  alter column attempt_token set not null;

create unique index if not exists ebay_provider_dispatch_leases_attempt_token_key
  on private.ebay_provider_dispatch_leases (attempt_token);

create or replace function private.begin_ebay_transactional_dispatch_for_tenant(
  p_user_id text,
  p_resource_id uuid,
  p_operation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
  v_attempted_at timestamptz := statement_timestamp();
  v_attempt_token uuid := gen_random_uuid();
begin
  if p_operation not in ('publish', 'reprice') then
    raise exception using errcode = '22023', message = 'Unsupported eBay dispatch operation';
  end if;
  v_account := private.lock_ebay_messaging_account(p_user_id);
  perform private.expire_ebay_provider_dispatch_leases(p_user_id);
  if v_account.seller_erased then
    raise exception using errcode = '42501', message = 'eBay seller account has been erased';
  end if;
  perform 1
  from public.ebay_connections connection
  where connection.user_id = p_user_id
    and connection.account_generation = v_account.generation;
  if not found then
    raise exception using errcode = '42501', message = 'A current eBay connection is required';
  end if;
  perform 1
  from public.listings listing
  where listing.id = p_resource_id
    and listing.user_id = p_user_id
    and listing.platform = 'ebay';
  if not found then
    raise exception using errcode = '42501', message = 'The eBay dispatch resource is unavailable';
  end if;

  insert into private.ebay_provider_dispatch_leases (
    user_id,
    message_id,
    account_generation,
    dispatch_kind,
    attempt_token,
    attempted_at,
    expires_at
  ) values (
    p_user_id,
    p_resource_id,
    v_account.generation,
    p_operation,
    v_attempt_token,
    v_attempted_at,
    v_attempted_at + interval '5 minutes'
  );
  return jsonb_build_object(
    'account_generation', v_account.generation,
    'attempt_token', v_attempt_token,
    'attempted_at', v_attempted_at
  );
exception when unique_violation then
  raise exception using errcode = '40001', message = 'eBay provider dispatch is already active';
end;
$$;

revoke all on function private.begin_ebay_transactional_dispatch_for_tenant(
  text, uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.begin_ebay_transactional_dispatch(
  p_resource_id uuid,
  p_operation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  return private.begin_ebay_transactional_dispatch_for_tenant(
    v_user_id,
    p_resource_id,
    p_operation
  );
end;
$$;

revoke all on function public.begin_ebay_transactional_dispatch(uuid, text)
  from public, anon, service_role;
grant execute on function public.begin_ebay_transactional_dispatch(uuid, text)
  to authenticated;

drop function if exists public.renew_ebay_transactional_dispatch(uuid, text, uuid);
drop function if exists private.renew_ebay_transactional_dispatch_for_tenant(
  text, uuid, text, uuid
);
drop function if exists public.end_ebay_transactional_dispatch(uuid, text, uuid);

create or replace function private.renew_ebay_transactional_dispatch_for_tenant(
  p_user_id text,
  p_resource_id uuid,
  p_operation text,
  p_account_generation uuid,
  p_attempt_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.ebay_provider_dispatch_leases lease
  set expires_at = statement_timestamp() + interval '5 minutes'
  where lease.user_id = p_user_id
    and lease.message_id = p_resource_id
    and lease.dispatch_kind = p_operation
    and lease.account_generation = p_account_generation
    and lease.attempt_token = p_attempt_token
    and lease.expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = '40001', message = 'eBay provider dispatch lease expired';
  end if;
end;
$$;

revoke all on function private.renew_ebay_transactional_dispatch_for_tenant(
  text, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function public.renew_ebay_transactional_dispatch(
  p_resource_id uuid,
  p_operation text,
  p_account_generation uuid,
  p_attempt_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  perform private.renew_ebay_transactional_dispatch_for_tenant(
    v_user_id,
    p_resource_id,
    p_operation,
    p_account_generation,
    p_attempt_token
  );
end;
$$;

revoke all on function public.renew_ebay_transactional_dispatch(
  uuid, text, uuid, uuid
) from public, anon, service_role;
grant execute on function public.renew_ebay_transactional_dispatch(
  uuid, text, uuid, uuid
) to authenticated;

create or replace function public.end_ebay_transactional_dispatch(
  p_resource_id uuid,
  p_operation text,
  p_account_generation uuid,
  p_attempt_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  delete from private.ebay_provider_dispatch_leases lease
  where lease.user_id = v_user_id
    and lease.message_id = p_resource_id
    and lease.dispatch_kind = p_operation
    and lease.account_generation = p_account_generation
    and lease.attempt_token = p_attempt_token;
end;
$$;

revoke all on function public.end_ebay_transactional_dispatch(
  uuid, text, uuid, uuid
) from public, anon, service_role;
grant execute on function public.end_ebay_transactional_dispatch(
  uuid, text, uuid, uuid
) to authenticated;

create or replace function private.record_unresolved_ebay_buyer_provenance(
  p_user_id text,
  p_generation uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_buyer_hash text := private.hash_ebay_identity(
    'sender_id',
    p_payload->>'external_buyer_id'
  );
  v_username_hash text := private.hash_ebay_identity(
    'sender_id',
    p_payload->>'external_buyer_username'
  );
begin
  if v_buyer_hash is null or v_username_hash is null then
    return;
  end if;
  insert into private.ebay_buyer_identity_provenance (
    user_id,
    account_generation,
    trading_identity_hash,
    username_identity_hash
  ) values (
    p_user_id,
    p_generation,
    v_buyer_hash,
    v_username_hash
  ) on conflict (
    user_id,
    account_generation,
    trading_identity_hash,
    username_identity_hash
  ) do nothing;
end;
$$;

revoke all on function private.record_unresolved_ebay_buyer_provenance(
  text, uuid, jsonb
) from public, anon, authenticated, service_role;

create or replace function private.apply_authenticated_ebay_message_write(
  p_operation text,
  p_payload jsonb,
  p_generation uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
  v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  v_result := private.apply_serialized_ebay_message_write_for_tenant(
    v_user_id,
    p_operation,
    p_payload,
    p_generation
  );
  if p_operation = 'upsert_unresolved_question' then
    perform private.record_unresolved_ebay_buyer_provenance(
      v_user_id,
      p_generation,
      p_payload
    );
  end if;
  return v_result;
end;
$$;

revoke all on function private.apply_authenticated_ebay_message_write(
  text, jsonb, uuid
) from public, anon, service_role;
grant execute on function private.apply_authenticated_ebay_message_write(
  text, jsonb, uuid
) to authenticated;

create or replace function private.apply_scheduled_ebay_message_write(
  p_user_id text,
  p_operation text,
  p_payload jsonb,
  p_generation uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  if p_operation not in (
    'sync_mark_attempt',
    'sync_mark_success',
    'sync_mark_failure',
    'upsert_unresolved_question',
    'mark_unresolved_question_failed',
    'remove_unresolved_question',
    'retire_unresolved_question',
    'mark_externally_answered',
    'mark_provider_unavailable',
    'import_question',
    'ensure_notification',
    'claim_draft',
    'attach_draft',
    'mark_draft_failed'
  ) then
    raise exception using errcode = '42501', message = 'Scheduler operation is not allowed';
  end if;
  v_result := private.apply_serialized_ebay_message_write_for_tenant(
    p_user_id,
    p_operation,
    p_payload,
    p_generation
  );
  if p_operation = 'upsert_unresolved_question' then
    perform private.record_unresolved_ebay_buyer_provenance(
      p_user_id,
      p_generation,
      p_payload
    );
  end if;
  return v_result;
end;
$$;

revoke all on function private.apply_scheduled_ebay_message_write(
  text, text, jsonb, uuid
) from public, anon, authenticated;
grant execute on function private.apply_scheduled_ebay_message_write(
  text, text, jsonb, uuid
) to service_role;

create or replace function private.assert_ebay_sandbox_fallback_identity(
  p_user_id text,
  p_seller_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
  v_binding private.ebay_sandbox_fallback_bindings%rowtype;
  v_seller_hash text := private.hash_ebay_identity('user_id', p_seller_id);
begin
  if v_seller_hash is null then
    raise exception using errcode = '22023', message = 'A Sandbox seller identity is required';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('ebay-identity:user_id:' || v_seller_hash, 0)
  );
  v_account := private.lock_ebay_messaging_account(p_user_id);
  select binding.*
  into v_binding
  from private.ebay_sandbox_fallback_bindings binding
  where binding.user_id = p_user_id
  for update;
  if found and (
    v_binding.account_generation is distinct from v_account.generation
    or v_binding.seller_identity_hash is distinct from v_seller_hash
  ) then
    raise exception using errcode = '42501', message = 'Sandbox fallback identity generation changed';
  end if;
  if exists (
    select 1
    from private.ebay_seller_identity_tenants identity
    where identity.user_id = p_user_id
      and identity.account_generation = v_account.generation
      and identity.hash_version = 1
      and identity.identity_kind = 'username'
  ) and not exists (
    select 1
    from private.ebay_seller_identity_tenants identity
    where identity.user_id = p_user_id
      and identity.account_generation = v_account.generation
      and identity.hash_version = 1
      and identity.identity_kind = 'user_id'
      and identity.identity_hash = v_seller_hash
      and (
        v_binding.user_id is null
        or identity.linked_at < v_binding.bound_at
      )
  ) then
    raise exception using errcode = '42501', message = 'Sandbox fallback identity does not match this account generation';
  end if;
end;
$$;

revoke all on function private.assert_ebay_sandbox_fallback_identity(text, text)
  from public, anon, authenticated, service_role;

create or replace function public.bind_ebay_sandbox_fallback(p_seller_id text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  perform private.assert_ebay_sandbox_fallback_identity(v_user_id, p_seller_id);
  return private.bind_ebay_sandbox_fallback_for_tenant(v_user_id, p_seller_id);
end;
$$;

revoke all on function public.bind_ebay_sandbox_fallback(text)
  from public, anon, service_role;
grant execute on function public.bind_ebay_sandbox_fallback(text)
  to authenticated;

create or replace function public.bind_scheduled_ebay_sandbox_fallback(
  p_user_id text,
  p_seller_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;
  perform private.assert_ebay_sandbox_fallback_identity(p_user_id, p_seller_id);
  return private.bind_ebay_sandbox_fallback_for_tenant(p_user_id, p_seller_id);
end;
$$;

revoke all on function public.bind_scheduled_ebay_sandbox_fallback(text, text)
  from public, anon, authenticated;
grant execute on function public.bind_scheduled_ebay_sandbox_fallback(text, text)
  to service_role;
