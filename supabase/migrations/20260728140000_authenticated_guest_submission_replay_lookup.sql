-- Issue #332: let a project-signed authenticated guest replay only its own
-- durable mobile submission through the publishable-key client. Keep the
-- original three-argument service-role capability unchanged for existing
-- signed-in submission composition.

create or replace function public.find_mobile_item_submission(
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns table (
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  photo_identity_kind text,
  photo_identity_fingerprint text,
  photo_receipts jsonb,
  is_replay boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.assert_verified_guest_capability();
  v_submission private.mobile_item_submissions%rowtype;
begin
  if p_idempotency_key is null
    or coalesce(p_request_fingerprint, '') !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid authenticated guest submission replay identity';
  end if;

  select submission.* into v_submission
  from private.mobile_item_submissions submission
  where submission.user_id = v_user_id
    and submission.idempotency_key = p_idempotency_key;
  if not found then return; end if;

  if v_submission.request_fingerprint is distinct from p_request_fingerprint then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission idempotency conflict';
  end if;
  if v_submission.state = 'uploading' then return; end if;

  item_id := v_submission.item_id;
  run_id := v_submission.run_id;
  queue_message_id := v_submission.queue_message_id;
  photo_identity_kind := v_submission.photo_identity_kind;
  photo_identity_fingerprint := v_submission.photo_identity_fingerprint;
  photo_receipts := v_submission.photo_receipts;
  is_replay := true;
  return next;
end;
$$;

revoke all on function public.find_mobile_item_submission(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.find_mobile_item_submission(uuid, text)
  to authenticated;
