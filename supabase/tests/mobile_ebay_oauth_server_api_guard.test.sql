begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(7);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-oauth-server-api-guard","role":"authenticated"}',
  true
);

select set_config(
  'request.headers',
  '{"apikey":"sb_secret_local_test"}',
  true
);
select extensions.lives_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000001',
    '67600000-0000-4000-8000-000000000011'
  )$$,
  'mobile OAuth accepts the raw local secret-key shape'
);

select set_config(
  'request.headers',
  '{"apikey":"eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.test-signature"}',
  true
);
select extensions.lives_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000002',
    '67600000-0000-4000-8000-000000000012'
  )$$,
  'mobile OAuth accepts the hosted service-role JWT shape'
);

select set_config(
  'request.headers',
  '{"apikey":"eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test-signature"}',
  true
);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000003',
    '67600000-0000-4000-8000-000000000013'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects the hosted anon-role JWT shape'
);

select set_config(
  'request.headers',
  '{"apikey":"sb_publishable_local_test"}',
  true
);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000004',
    '67600000-0000-4000-8000-000000000014'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects the raw publishable-key shape'
);

select set_config('request.headers', '{"apikey":""}', true);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000005',
    '67600000-0000-4000-8000-000000000015'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects an empty API key'
);

select set_config(
  'request.headers',
  '{"apikey":"e30.eA.c2ln"}',
  true
);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000006',
    '67600000-0000-4000-8000-000000000016'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects a malformed JWT without leaking a decode error'
);

select set_config(
  'request.headers',
  '{"apikey":"e30.e30.c2ln"}',
  true
);
select extensions.throws_ok(
  $$select public.create_mobile_ebay_oauth_session(
    '67600000-0000-4000-8000-000000000007',
    '67600000-0000-4000-8000-000000000017'
  )$$,
  '42501',
  'Server API authorization is required',
  'mobile OAuth rejects a JWT whose payload has no server role'
);

select * from extensions.finish();
rollback;
