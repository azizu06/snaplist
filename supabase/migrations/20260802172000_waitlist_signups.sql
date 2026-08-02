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

-- PostgREST clients get no table privilege and no RLS policy. The server action
-- uses the server-only service-role client and receives only the insert privilege
-- it needs. Operator export remains a direct database operation.
revoke all on table public.waitlist_signups
  from public, anon, authenticated, service_role;
grant insert on table public.waitlist_signups to service_role;
