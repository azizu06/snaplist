-- Expand the optional canonical WAV to 45 seconds / 1536 KiB.
-- Existing tenant/path validation and private capability boundaries are preserved.

create or replace function private.assert_mobile_submission_voice_receipt(
  p_user_id text,
  p_batch_id uuid,
  p_voice_receipt jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_storage_path text;
  v_locale jsonb;
begin
  if p_voice_receipt is null then
    return;
  end if;
  if jsonb_typeof(p_voice_receipt) <> 'object'
    or not (p_voice_receipt ?& array[
      'version',
      'storage_path',
      'content_sha256',
      'byte_length',
      'duration_ms',
      'locale',
      'media_type'
    ])
    or (select count(*) from jsonb_object_keys(p_voice_receipt)) <> 7
    or p_voice_receipt->>'version' is distinct from '1'
    or jsonb_typeof(p_voice_receipt->'version') <> 'number'
    or p_voice_receipt->>'content_sha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_voice_receipt->'byte_length') <> 'number'
    or (p_voice_receipt->>'byte_length') !~ '^[0-9]+$'
    or (p_voice_receipt->>'byte_length')::integer not between 1 and 1572864
    or jsonb_typeof(p_voice_receipt->'duration_ms') <> 'number'
    or (p_voice_receipt->>'duration_ms') !~ '^[0-9]+$'
    or (p_voice_receipt->>'duration_ms')::integer not between 1 and 45000
    or p_voice_receipt->>'media_type' is distinct from 'audio/wav' then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile submission voice receipt';
  end if;

  v_locale := p_voice_receipt->'locale';
  if jsonb_typeof(v_locale) not in ('string', 'null')
    or (
      jsonb_typeof(v_locale) = 'string'
      and (
        char_length(p_voice_receipt->>'locale') not between 1 and 255
        or p_voice_receipt->>'locale' ~ '[[:cntrl:]]'
      )
    ) then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile submission voice locale';
  end if;

  v_storage_path := p_voice_receipt->>'storage_path';
  if coalesce(char_length(v_storage_path), 0) < 1
    or char_length(v_storage_path) > 1024
    or left(
      v_storage_path,
      char_length(p_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/')
    ) <> p_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/'
    or v_storage_path like '%://%'
    or v_storage_path like '%?%'
    or v_storage_path like '%#%' then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile submission voice path';
  end if;
end;
$$;

revoke all on function private.assert_mobile_submission_voice_receipt(
  text, uuid, jsonb
) from public, anon, authenticated, service_role;

