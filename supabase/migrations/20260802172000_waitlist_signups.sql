-- Issue #620: collect launch waitlist addresses in SnapList's own database.
-- No sender or external email provider is part of this capability.
create table public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now(),
  constraint waitlist_signups_email_normalized_check
    check (
      email = lower(btrim(email))
      and char_length(email) between 3 and 254
    ),
  constraint waitlist_signups_email_key unique (email)
);

comment on table public.waitlist_signups is
  'Normalized email addresses collected for one SnapList launch notification (issue #620).';
comment on column public.waitlist_signups.email is
  'Lowercase, trimmed launch waitlist address. Duplicate inserts are silent at the server-action boundary.';

alter table public.waitlist_signups enable row level security;

create table private.waitlist_signup_rate_limit_windows (
  window_started_at timestamptz primary key,
  attempts integer not null,
  constraint waitlist_signup_rate_limit_attempts_positive_check
    check (attempts > 0)
);

comment on table private.waitlist_signup_rate_limit_windows is
  'Global minute-window admission counts for the launch waitlist. Stores no visitor identifier.';

-- Admission and insertion are one atomic database operation. A rejected attempt
-- returns false and writes no email. A duplicate address is a silent no-op.
create or replace function public.insert_waitlist_signup(
  p_email text,
  p_rate_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_started_at timestamptz := date_trunc('minute', statement_timestamp());
  v_attempts integer;
begin
  if p_rate_limit is null or p_rate_limit < 1 or p_rate_limit > 1000 then
    raise exception 'waitlist rate limit must be between 1 and 1000'
      using errcode = '22023';
  end if;

  delete from private.waitlist_signup_rate_limit_windows
  where window_started_at < v_window_started_at - interval '1 hour';

  insert into private.waitlist_signup_rate_limit_windows (
    window_started_at,
    attempts
  )
  values (v_window_started_at, 1)
  on conflict (window_started_at) do update
  set attempts = private.waitlist_signup_rate_limit_windows.attempts + 1
  where private.waitlist_signup_rate_limit_windows.attempts < p_rate_limit
  returning attempts into v_attempts;

  if v_attempts is null then
    return false;
  end if;

  insert into public.waitlist_signups (email)
  values (p_email)
  on conflict (email) do nothing;

  return true;
end;
$$;

-- PostgREST clients get no table privilege, no RLS policy, and no function
-- execution. The server action can invoke only the narrow privileged function.
-- Operator export remains a direct database operation.
revoke all on table public.waitlist_signups
  from public, anon, authenticated, service_role;
revoke all on table private.waitlist_signup_rate_limit_windows
  from public, anon, authenticated, service_role;
revoke all on function public.insert_waitlist_signup(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.insert_waitlist_signup(text, integer)
  to service_role;
