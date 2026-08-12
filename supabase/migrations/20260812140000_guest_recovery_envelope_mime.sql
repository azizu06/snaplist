-- Issue #792: the guest-recovery producer writes an AES-GCM ciphertext envelope
-- into the `photos` bucket, and `application/octet-stream` is the truthful label
-- for those bytes. The bucket allowlist was image-only, so Supabase Storage
-- answered 415 and every guest item run dead-lettered.
--
-- Append rather than rewrite, guarded on absence, so a re-run is a no-op and the
-- existing image types plus the `audio/wav` entry added by
-- 20260730120000_mobile_item_submission_voice_v2.sql all survive.

update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'application/octet-stream')
where id = 'photos'
  and allowed_mime_types is not null
  and not ('application/octet-stream' = any(allowed_mime_types));
