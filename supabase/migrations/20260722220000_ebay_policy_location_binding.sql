-- Issue #388: persist display-safe eBay policy/location discovery on the
-- seller-owned connection row. A connection generation tracks encrypted OAuth
-- grant replacement independently from the seller account generation.

alter table public.ebay_connections
  add column connection_generation uuid not null default gen_random_uuid(),
  add column policy_location_bindings jsonb not null default '{}'::jsonb;

alter table public.ebay_connections
  add constraint ebay_connections_policy_location_bindings_object_check
  check (jsonb_typeof(policy_location_bindings) = 'object');

comment on column public.ebay_connections.connection_generation is
  'Changes whenever the encrypted eBay refresh grant is replaced. Discovery saved against an older generation is stale.';

comment on column public.ebay_connections.policy_location_bindings is
  'Display-safe policy and enabled-location discovery keyed by eBay marketplace. Contains no token, address, phone, description, or provider-secret fields.';

create function private.advance_ebay_connection_generation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.refresh_token_enc is distinct from old.refresh_token_enc then
    new.connection_generation := gen_random_uuid();
    new.policy_location_bindings := '{}'::jsonb;
  else
    new.connection_generation := old.connection_generation;
  end if;
  return new;
end;
$$;

revoke all on function private.advance_ebay_connection_generation()
  from public, anon, authenticated, service_role;

create trigger ebay_connections_advance_connection_generation
before update of refresh_token_enc on public.ebay_connections
for each row execute function private.advance_ebay_connection_generation();

create function private.validate_ebay_policy_location_choice(p_choice jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
  v_state text;
  v_selected_id text;
  v_candidate jsonb;
  v_candidate_keys text[];
  v_candidate_id text;
  v_candidate_label text;
  v_candidate_ids text[] := '{}'::text[];
  v_safe_candidates jsonb := '[]'::jsonb;
  v_candidate_count integer;
begin
  if jsonb_typeof(p_choice) <> 'object' then
    raise exception using errcode = '22023', message = 'eBay policy choice must be an object';
  end if;

  select array_agg(key order by key)
  into v_keys
  from jsonb_object_keys(p_choice) keys(key);
  if v_keys is distinct from array['candidates', 'selectedId', 'state']::text[] then
    raise exception using errcode = '22023', message = 'eBay policy choice fields are invalid';
  end if;
  if jsonb_typeof(p_choice->'state') <> 'string'
    or jsonb_typeof(p_choice->'candidates') <> 'array' then
    raise exception using errcode = '22023', message = 'eBay policy choice types are invalid';
  end if;

  v_state := p_choice->>'state';
  if v_state not in ('bound', 'setupRequired', 'selectionRequired') then
    raise exception using errcode = '22023', message = 'eBay policy choice state is invalid';
  end if;

  for v_candidate in
    select value from jsonb_array_elements(p_choice->'candidates') candidates(value)
  loop
    if jsonb_typeof(v_candidate) <> 'object' then
      raise exception using errcode = '22023', message = 'eBay policy candidate must be an object';
    end if;
    select array_agg(key order by key)
    into v_candidate_keys
    from jsonb_object_keys(v_candidate) keys(key);
    if v_candidate_keys is distinct from array['id', 'label', 'providerDefault']::text[] then
      raise exception using errcode = '22023', message = 'eBay policy candidate fields are invalid';
    end if;
    if jsonb_typeof(v_candidate->'id') <> 'string'
      or jsonb_typeof(v_candidate->'label') <> 'string'
      or jsonb_typeof(v_candidate->'providerDefault') <> 'boolean' then
      raise exception using errcode = '22023', message = 'eBay policy candidate types are invalid';
    end if;

    v_candidate_id := v_candidate->>'id';
    v_candidate_label := v_candidate->>'label';
    if nullif(btrim(v_candidate_id), '') is null
      or length(v_candidate_id) > 256
      or nullif(btrim(v_candidate_label), '') is null
      or length(v_candidate_label) > 80
      or v_candidate_label ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'eBay policy candidate is not display safe';
    end if;
    if v_candidate_id = any(v_candidate_ids) then
      raise exception using errcode = '22023', message = 'eBay policy candidate identifiers must be unique';
    end if;

    v_candidate_ids := array_append(v_candidate_ids, v_candidate_id);
    v_safe_candidates := v_safe_candidates || jsonb_build_array(
      jsonb_build_object(
        'id', v_candidate_id,
        'label', v_candidate_label,
        'providerDefault', (v_candidate->>'providerDefault')::boolean
      )
    );
  end loop;

  v_candidate_count := coalesce(cardinality(v_candidate_ids), 0);
  if v_state = 'bound' then
    if jsonb_typeof(p_choice->'selectedId') <> 'string' then
      raise exception using errcode = '22023', message = 'A bound eBay policy choice needs a selection';
    end if;
    v_selected_id := p_choice->>'selectedId';
    if v_candidate_count < 1 or not (v_selected_id = any(v_candidate_ids)) then
      raise exception using errcode = '22023', message = 'The selected eBay policy candidate is unavailable';
    end if;
  elsif p_choice->'selectedId' is distinct from 'null'::jsonb then
    raise exception using errcode = '22023', message = 'An unresolved eBay policy choice cannot select a candidate';
  elsif v_state = 'setupRequired' and v_candidate_count <> 0 then
    raise exception using errcode = '22023', message = 'eBay setup is required only when no candidates exist';
  elsif v_state = 'selectionRequired' and v_candidate_count < 2 then
    raise exception using errcode = '22023', message = 'eBay selection is required only for ambiguous candidates';
  end if;

  return jsonb_build_object(
    'state', v_state,
    'selectedId', case when v_state = 'bound' then to_jsonb(v_selected_id) else 'null'::jsonb end,
    'candidates', v_safe_candidates
  );
end;
$$;

revoke all on function private.validate_ebay_policy_location_choice(jsonb)
  from public, anon, authenticated, service_role;

create function private.validate_ebay_policy_location_binding(
  p_marketplace_id text,
  p_connection_generation uuid,
  p_binding jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
  v_binding_generation uuid;
  v_fulfillment jsonb;
  v_payment jsonb;
  v_return jsonb;
  v_location jsonb;
  v_expected_state text;
begin
  if nullif(btrim(p_marketplace_id), '') is null
    or length(p_marketplace_id) > 64
    or p_marketplace_id !~ '^EBAY_[A-Z0-9_]{2,59}$' then
    raise exception using errcode = '22023', message = 'eBay marketplace is invalid';
  end if;
  if jsonb_typeof(p_binding) <> 'object' or pg_column_size(p_binding) > 1048576 then
    raise exception using errcode = '22023', message = 'eBay policy binding is invalid';
  end if;

  select array_agg(key order by key)
  into v_keys
  from jsonb_object_keys(p_binding) keys(key);
  if v_keys is distinct from array[
    'connectionGeneration',
    'discoveredAt',
    'fulfillmentPolicy',
    'inventoryLocation',
    'marketplaceId',
    'paymentPolicy',
    'returnPolicy',
    'state'
  ]::text[] then
    raise exception using errcode = '22023', message = 'eBay policy binding fields are invalid';
  end if;
  if jsonb_typeof(p_binding->'marketplaceId') <> 'string'
    or jsonb_typeof(p_binding->'connectionGeneration') <> 'string'
    or jsonb_typeof(p_binding->'discoveredAt') <> 'string'
    or jsonb_typeof(p_binding->'state') <> 'string' then
    raise exception using errcode = '22023', message = 'eBay policy binding types are invalid';
  end if;
  if p_binding->>'marketplaceId' is distinct from p_marketplace_id then
    raise exception using errcode = '22023', message = 'eBay policy binding marketplace does not match';
  end if;

  begin
    v_binding_generation := (p_binding->>'connectionGeneration')::uuid;
    perform (p_binding->>'discoveredAt')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'eBay policy binding identity or time is invalid';
  end;
  if v_binding_generation is distinct from p_connection_generation then
    raise exception using errcode = '22023', message = 'eBay policy binding generation does not match';
  end if;

  v_fulfillment := private.validate_ebay_policy_location_choice(
    p_binding->'fulfillmentPolicy'
  );
  v_payment := private.validate_ebay_policy_location_choice(
    p_binding->'paymentPolicy'
  );
  v_return := private.validate_ebay_policy_location_choice(
    p_binding->'returnPolicy'
  );
  v_location := private.validate_ebay_policy_location_choice(
    p_binding->'inventoryLocation'
  );

  v_expected_state := case
    when 'selectionRequired' in (
      v_fulfillment->>'state',
      v_payment->>'state',
      v_return->>'state',
      v_location->>'state'
    ) then 'selectionRequired'
    when 'setupRequired' in (
      v_fulfillment->>'state',
      v_payment->>'state',
      v_return->>'state',
      v_location->>'state'
    ) then 'setupRequired'
    else 'ready'
  end;
  if p_binding->>'state' is distinct from v_expected_state then
    raise exception using errcode = '22023', message = 'eBay policy binding aggregate state is invalid';
  end if;

  return jsonb_build_object(
    'state', v_expected_state,
    'marketplaceId', p_marketplace_id,
    'connectionGeneration', p_connection_generation,
    'fulfillmentPolicy', v_fulfillment,
    'paymentPolicy', v_payment,
    'returnPolicy', v_return,
    'inventoryLocation', v_location,
    'discoveredAt', p_binding->>'discoveredAt'
  );
end;
$$;

revoke all on function private.validate_ebay_policy_location_binding(
  text, uuid, jsonb
) from public, anon, authenticated, service_role;

create function public.save_ebay_policy_location_binding(
  p_marketplace_id text,
  p_connection_generation uuid,
  p_binding jsonb
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
  v_connection public.ebay_connections%rowtype;
  v_safe_binding jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or nullif(v_user_id, '') is null then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;

  v_safe_binding := private.validate_ebay_policy_location_binding(
    p_marketplace_id,
    p_connection_generation,
    p_binding
  );

  select connection.*
  into v_connection
  from public.ebay_connections connection
  join private.ebay_messaging_account_generations account
    on account.user_id = connection.user_id
    and account.generation = connection.account_generation
  where connection.user_id = v_user_id
    and account.seller_erased = false
  for update of connection;
  if not found then
    raise exception using errcode = '22023', message = 'An active eBay connection is required';
  end if;
  if v_connection.connection_generation is distinct from p_connection_generation then
    raise exception using errcode = '40001', message = 'The eBay connection changed during policy discovery';
  end if;

  update public.ebay_connections connection
  set policy_location_bindings = jsonb_set(
    connection.policy_location_bindings,
    array[p_marketplace_id],
    v_safe_binding,
    true
  )
  where connection.user_id = v_user_id;

  return v_safe_binding;
end;
$$;

revoke all on function public.save_ebay_policy_location_binding(
  text, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.save_ebay_policy_location_binding(
  text, uuid, jsonb
) to authenticated;
