-- Hosted operator provisioning (run only after setting the deployed
-- SERVER_RPC_SECRET to `openssl rand -base64 48` output: exactly 64 unpadded
-- Base64 characters. Never commit that value):
--
-- insert into private.server_rpc_auth_config (singleton, secret_sha256)
-- values (
--   true,
--   encode(
--     extensions.digest(
--       convert_to('<production SERVER_RPC_SECRET>', 'UTF8'),
--       'sha256'
--     ),
--     'hex'
--   )
-- )
-- on conflict (singleton) do update
-- set secret_sha256 = excluded.secret_sha256,
--     provisioned_at = statement_timestamp();
--
-- The migration deliberately inserts no row. Until an operator provisions the
-- digest, every tenant-bound guarded RPC fails closed with SQLSTATE 42501.

create table private.server_rpc_auth_config (
  singleton boolean primary key default true check (singleton),
  secret_sha256 text not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  provisioned_at timestamp with time zone not null default statement_timestamp()
);

comment on table private.server_rpc_auth_config is
  'Singleton SHA-256 digest for x-snaplist-server-auth. Operator-provisioned per environment; plaintext is never stored.';

revoke all on table private.server_rpc_auth_config
  from public, anon, authenticated, service_role;

create function private.is_server_api_request()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb;
  v_headers jsonb;
  v_server_auth text;
begin
  begin
    v_claims := nullif(
      current_setting('request.jwt.claims', true),
      ''
    )::jsonb;
  exception when others then
    return false;
  end;

  if jsonb_typeof(v_claims) = 'object'
    and v_claims->>'role' = 'service_role' then
    return true;
  end if;

  begin
    v_headers := nullif(
      current_setting('request.headers', true),
      ''
    )::jsonb;
  exception when others then
    return false;
  end;

  if jsonb_typeof(v_headers) <> 'object' then
    return false;
  end if;

  v_server_auth := v_headers->>'x-snaplist-server-auth';
  if nullif(v_server_auth, '') is null then
    return false;
  end if;

  return exists (
    select 1
    from private.server_rpc_auth_config config
    where config.singleton
      and config.secret_sha256 = encode(
        extensions.digest(convert_to(v_server_auth, 'UTF8'), 'sha256'),
        'hex'
      )
  );
exception when others then
  return false;
end;
$$;

comment on function private.is_server_api_request() is
  'Accepts gateway-validated service_role claims or a forwarded x-snaplist-server-auth value whose SHA-256 matches the private operator-provisioned digest.';

revoke all on function private.is_server_api_request()
  from public, anon, authenticated, service_role;

do $$
declare
  v_expected_functions constant regprocedure[] := array[
    'private.apply_authenticated_ebay_message_write(text,jsonb,uuid)'::regprocedure,
    'private.enforce_message_attachment_server_update()'::regprocedure,
    'public.begin_ebay_message_write()'::regprocedure,
    'public.begin_ebay_transactional_dispatch(uuid,text,uuid,uuid,jsonb)'::regprocedure,
    'public.bind_ebay_publish_connection_generation(uuid,uuid,text,uuid,text,text,text,text)'::regprocedure,
    'public.bind_ebay_sandbox_fallback(text)'::regprocedure,
    'public.block_ebay_message_policy_delivery(uuid,text,uuid)'::regprocedure,
    'public.claim_ebay_message_write_with_photos(text,jsonb,uuid,text,uuid[])'::regprocedure,
    'public.complete_ebay_message_write_with_photos(text,jsonb,uuid,text)'::regprocedure,
    'public.complete_ebay_publish_dispatch(uuid,uuid,uuid,uuid,uuid,text,text,numeric,timestamp with time zone)'::regprocedure,
    'public.complete_ebay_reprice_dispatch(uuid,uuid,uuid,uuid,uuid,numeric,timestamp with time zone)'::regprocedure,
    'public.complete_own_message_photo_object_deletions(text[])'::regprocedure,
    'public.create_mobile_ebay_oauth_session(uuid,uuid)'::regprocedure,
    'public.delete_own_expired_message_photo_upload_intents(integer)'::regprocedure,
    'public.delete_own_expired_message_photo_upload_intents_for_request(text)'::regprocedure,
    'public.delete_own_message_photo_upload_intents_for_request(text)'::regprocedure,
    'public.disconnect_ebay_connection()'::regprocedure,
    'public.end_ebay_transactional_dispatch(uuid,text,uuid,uuid,uuid,uuid)'::regprocedure,
    'public.list_own_message_photo_object_deletions(integer)'::regprocedure,
    'public.record_ebay_message_policy_decision(uuid,jsonb,uuid)'::regprocedure,
    'public.renew_ebay_transactional_dispatch(uuid,text,uuid,uuid,uuid,uuid)'::regprocedure,
    'public.save_ebay_connection(text,text,text,text,timestamp with time zone,text[])'::regprocedure,
    'public.save_ebay_policy_location_binding(text,uuid,jsonb)'::regprocedure,
    'public.stage_message_photo_upload_intents(text,uuid[])'::regprocedure,
    'public.update_ebay_access_token_cache(uuid,text,timestamp with time zone)'::regprocedure
  ];
  v_guarded_functions regprocedure[];
  v_api_key_readers regprocedure[];
  v_definition text;
  v_old_guard constant text := 'not private.is_server_api_request(v_api_key)';
  v_new_guard constant text := 'not private.is_server_api_request()';
  v_old_api_key_declaration constant text := $declaration$  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
$declaration$;
  v_old_compact_api_key_declaration constant text := $declaration$  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey', ''
  );
$declaration$;
begin
  select coalesce(
    array_agg(
      function.oid::regprocedure
      order by function.oid::regprocedure::text
    ),
    '{}'::regprocedure[]
  )
  into v_guarded_functions
  from pg_catalog.pg_proc function
  join pg_catalog.pg_namespace namespace
    on namespace.oid = function.pronamespace
  where namespace.nspname in ('private', 'public')
    and function.prokind = 'f'
    and strpos(function.prosrc, v_old_guard) > 0;

  if not (
    v_guarded_functions @> v_expected_functions
    and v_expected_functions @> v_guarded_functions
  ) then
    raise exception
      'Live forwarded-secret server API guards differ from the mapped function set. Found: %',
      v_guarded_functions;
  end if;

  select coalesce(
    array_agg(
      function.oid::regprocedure
      order by function.oid::regprocedure::text
    ),
    '{}'::regprocedure[]
  )
  into v_api_key_readers
  from pg_catalog.pg_proc function
  join pg_catalog.pg_namespace namespace
    on namespace.oid = function.pronamespace
  where namespace.nspname in ('private', 'public')
    and function.prokind = 'f'
    and strpos(function.prosrc, 'v_api_key text := coalesce(') > 0
    and strpos(function.prosrc, '->>''apikey''') > 0;

  if not (
    v_api_key_readers @> v_expected_functions
    and v_expected_functions @> v_api_key_readers
  ) then
    raise exception
      'Live apikey readers differ from the mapped function set. Found: %',
      v_api_key_readers;
  end if;

  for v_definition in
    select pg_catalog.pg_get_functiondef(function.oid)
    from pg_catalog.pg_proc function
    where function.oid = any(v_expected_functions)
    order by function.oid::regprocedure::text
  loop
    execute replace(
      replace(
        replace(v_definition, v_old_guard, v_new_guard),
        v_old_api_key_declaration,
        ''
      ),
      v_old_compact_api_key_declaration,
      ''
    );
  end loop;

  select coalesce(
    array_agg(
      function.oid::regprocedure
      order by function.oid::regprocedure::text
    ),
    '{}'::regprocedure[]
  )
  into v_guarded_functions
  from pg_catalog.pg_proc function
  join pg_catalog.pg_namespace namespace
    on namespace.oid = function.pronamespace
  where namespace.nspname in ('private', 'public')
    and function.prokind = 'f'
    and strpos(function.prosrc, v_new_guard) > 0;

  if not (
    v_guarded_functions @> v_expected_functions
    and v_expected_functions @> v_guarded_functions
  ) then
    raise exception
      'Rewritten server API guards differ from the mapped function set. Found: %',
      v_guarded_functions;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc function
    where function.oid = any(v_expected_functions)
      and strpos(function.prosrc, 'v_api_key text := coalesce(') > 0
      and strpos(function.prosrc, '->>''apikey''') > 0
  ) then
    raise exception 'A rewritten server API guard still reads the apikey header';
  end if;
end;
$$;

drop function private.is_server_api_request(text);
