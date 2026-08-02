begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(13);

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
  has_table_privilege('service_role', 'public.waitlist_signups', 'insert'),
  'the server-only service role may insert a waitlist row'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.waitlist_signups', 'select')
    and not has_table_privilege('service_role', 'public.waitlist_signups', 'update')
    and not has_table_privilege('service_role', 'public.waitlist_signups', 'delete'),
  'the server-only service role receives no unnecessary table privilege'
);

select extensions.lives_ok(
  $$
    insert into public.waitlist_signups (email)
    values ('person@example.com')
  $$,
  'a normalized address can join the waitlist'
);

select extensions.throws_ok(
  $$
    insert into public.waitlist_signups (email)
    values ('person@example.com')
  $$,
  '23505',
  null,
  'a duplicate normalized address is rejected by the unique constraint'
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

select * from extensions.finish();
rollback;
