create function private.is_server_api_request(p_api_key text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[];
  v_header jsonb;
  v_payload jsonb;
begin
  if coalesce(p_api_key, '') like 'sb_secret_%' then
    return true;
  end if;

  v_parts := string_to_array(coalesce(p_api_key, ''), '.');
  if cardinality(v_parts) <> 3
    or nullif(v_parts[1], '') is null
    or nullif(v_parts[2], '') is null
    or nullif(v_parts[3], '') is null
    or v_parts[1] !~ '^[A-Za-z0-9_-]+$'
    or v_parts[2] !~ '^[A-Za-z0-9_-]+$'
    or v_parts[3] !~ '^[A-Za-z0-9_-]+$'
    or length(v_parts[1]) % 4 = 1
    or length(v_parts[2]) % 4 = 1
    or length(v_parts[3]) % 4 = 1 then
    return false;
  end if;

  begin
    v_header := convert_from(
      decode(
        translate(v_parts[1], '-_', '+/')
          || repeat('=', (4 - length(v_parts[1]) % 4) % 4),
        'base64'
      ),
      'UTF8'
    )::jsonb;
    v_payload := convert_from(
      decode(
        translate(v_parts[2], '-_', '+/')
          || repeat('=', (4 - length(v_parts[2]) % 4) % 4),
        'base64'
      ),
      'UTF8'
    )::jsonb;
  exception when others then
    return false;
  end;

  return coalesce(
    jsonb_typeof(v_header) = 'object'
      and jsonb_typeof(v_payload) = 'object'
      and v_payload->>'role' = 'service_role',
    false
  );
end;
$$;

comment on function private.is_server_api_request(text) is
  'Recognizes gateway-validated server API key shapes after PostgREST request-header substitution. JWT signature validation remains the API gateway responsibility.';

revoke all on function private.is_server_api_request(text)
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
  v_definition text;
  v_old_guard constant text := 'v_api_key not like ''sb_secret_%''';
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
      'Live server API guards differ from the mapped function set. Found: %',
      v_guarded_functions;
  end if;

  for v_definition in
    select pg_catalog.pg_get_functiondef(function.oid)
    from pg_catalog.pg_proc function
    where function.oid = any(v_expected_functions)
    order by function.oid::regprocedure::text
  loop
    execute replace(
      v_definition,
      v_old_guard,
      'not private.is_server_api_request(v_api_key)'
    );
  end loop;
end;
$$;
