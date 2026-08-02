begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(24);

select extensions.has_table(
  'public', 'waitlist_signups',
  'launch waitlist signups are stored in SnapList'
);

select extensions.has_column(
  'public', 'waitlist_signups', 'email',
  'waitlist rows store the normalized email address'
);

select extensions.has_column(
  'public', 'waitlist_signups', 'created_at',
  'waitlist rows record when the address joined'
);

select extensions.has_table(
  'private', 'waitlist_signup_rate_limit_windows',
  'waitlist admission uses a shared database window'
);

select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'waitlist_signups'
  ),
  'waitlist rows have RLS enabled'
);

select extensions.is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'waitlist_signups'
  ),
  0::bigint,
  'waitlist rows have no client-access policy'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.waitlist_signups', 'select')
    and not has_table_privilege('anon', 'public.waitlist_signups', 'insert')
    and not has_table_privilege('anon', 'public.waitlist_signups', 'update')
    and not has_table_privilege('anon', 'public.waitlist_signups', 'delete'),
  'the anonymous PostgREST role cannot read or write waitlist rows'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.waitlist_signups', 'select')
    and not has_table_privilege('authenticated', 'public.waitlist_signups', 'insert')
    and not has_table_privilege('authenticated', 'public.waitlist_signups', 'update')
    and not has_table_privilege('authenticated', 'public.waitlist_signups', 'delete'),
  'the authenticated PostgREST role cannot read or write waitlist rows'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.waitlist_signups', 'select')
    and not has_table_privilege('service_role', 'public.waitlist_signups', 'insert')
    and not has_table_privilege('service_role', 'public.waitlist_signups', 'update')
    and not has_table_privilege('service_role', 'public.waitlist_signups', 'delete'),
  'the server-only service role cannot bypass the waitlist admission function'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.insert_waitlist_signup(text, integer)',
    'execute'
  ),
  'the anonymous PostgREST role cannot execute the privileged waitlist function'
);

select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.insert_waitlist_signup(text, integer)',
    'execute'
  ),
  'the authenticated PostgREST role cannot execute the privileged waitlist function'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.insert_waitlist_signup(text, integer)',
    'execute'
  ),
  'the server-only service role can execute the narrow waitlist function'
);

select extensions.is(
  public.insert_waitlist_signup('person@example.com', 100),
  true,
  'a normalized address can join through the privileged function'
);

select extensions.is(
  public.insert_waitlist_signup('person@example.com', 100),
  true,
  'a duplicate normalized address is a quiet success'
);

select extensions.is(
  (
    select count(*)
    from public.waitlist_signups
    where email = 'person@example.com'
  ),
  1::bigint,
  'a duplicate attempt leaves exactly one waitlist row'
);

select extensions.throws_ok(
  $$
    insert into public.waitlist_signups (email)
    values (' Person@Example.com ')
  $$,
  '23514',
  null,
  'the database refuses an email that bypasses server normalization'
);

delete from private.waitlist_signup_rate_limit_windows;

select extensions.is(
  public.insert_waitlist_signup('first@example.com', 2),
  true,
  'the first address inside the shared rate window is admitted'
);

select extensions.is(
  public.insert_waitlist_signup('second@example.com', 2),
  true,
  'the final address inside the shared rate window is admitted'
);

insert into private.waitlist_signup_rate_limit_windows (
  window_started_at,
  attempts
)
values ('2000-01-01 00:00:00+00'::timestamptz, 1);

select extensions.is(
  public.insert_waitlist_signup('rate-limited@example.com', 2),
  false,
  'an address beyond the shared rate limit is quietly rejected'
);

select extensions.is(
  (
    select count(*)
    from public.waitlist_signups
    where email = 'rate-limited@example.com'
  ),
  0::bigint,
  'a rate-limited address writes no waitlist row'
);

select extensions.is(
  (
    select count(*)
    from private.waitlist_signup_rate_limit_windows
  ),
  2::bigint,
  'a rate-limited address leaves the rate-window table exactly unchanged'
);

select extensions.ok(
  exists (
    select 1
    from private.waitlist_signup_rate_limit_windows
    where window_started_at = '2000-01-01 00:00:00+00'::timestamptz
  ),
  'a rate-limited address leaves the specific expired rate window intact'
);

select extensions.is(
  public.insert_waitlist_signup('cleanup@example.com', 3),
  true,
  'a new admission also performs bounded rate-window cleanup'
);

select extensions.is(
  (
    select count(*)
    from private.waitlist_signup_rate_limit_windows
    where window_started_at < date_trunc('minute', statement_timestamp()) - interval '1 hour'
  ),
  0::bigint,
  'expired shared rate windows are removed'
);

select * from extensions.finish();
rollback;
