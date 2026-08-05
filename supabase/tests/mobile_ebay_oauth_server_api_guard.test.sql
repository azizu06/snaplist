begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(7);

delete from private.server_rpc_auth_config;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-oauth-server-api-guard","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}',
  true
);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000001',
    '67600000-0000-4000-8000-000000000011'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects the correct header while the secret hash is unprovisioned'
);

reset role;
insert into private.server_rpc_auth_config (singleton, secret_sha256)
values (
  true,
  encode(
    extensions.digest(
      convert_to(
        'snaplist-local-server-rpc-secret-do-not-use-in-hosted',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
);

set local role authenticated;
select set_config('request.headers', '{}', true);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000002',
    '67600000-0000-4000-8000-000000000012'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects a missing server authorization header'
);

select set_config(
  'request.headers',
  '{"x-snaplist-server-auth":"wrong-server-rpc-secret"}',
  true
);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000003',
    '67600000-0000-4000-8000-000000000013'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects a wrong server authorization header'
);

select set_config('request.headers', 'not-json', true);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000004',
    '67600000-0000-4000-8000-000000000014'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects malformed request headers without leaking a parse error'
);

select set_config('request.jwt.claims', 'not-json', true);
select set_config(
  'request.headers',
  '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}',
  true
);
reset role;
select extensions.ok(
  not private.is_server_api_request(),
  'the server authorization helper rejects malformed request claims'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-oauth-server-api-guard","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}',
  true
);
select extensions.lives_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000006',
    '67600000-0000-4000-8000-000000000016'
  )$$,
  'mobile OAuth accepts the forwarded secret without an apikey header'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.headers', '{}', true);
select extensions.ok(
  private.is_server_api_request(),
  'mobile OAuth accepts gateway-validated service-role claims without a custom header'
);

select * from extensions.finish();
rollback;
