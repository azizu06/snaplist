-- SnapList — private `photos` storage bucket + user-scoped object policies.
--
-- PRD "Tenancy & data": "Photos in Supabase Storage, paths scoped by user_id,
-- access governed by RLS/storage policies."
--
-- Convention: every object lives at `{user_id}/...` (the first path segment is the
-- owner's auth uid). Policies on storage.objects scope access to objects whose
-- first folder segment equals auth.uid(), so a user can never read or write into
-- another user's prefix. storage.foldername(name) splits the object path on '/';
-- element [1] is the first segment.

-- Private bucket (public = false). 50MiB cap, common image mime types only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'photos',
  'photos',
  false,
  52428800, -- 50 MiB
  array['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do nothing;

-- RLS is already enabled on storage.objects by Supabase; we only add policies.

create policy "photos_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "photos_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "photos_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "photos_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
