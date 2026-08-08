-- Physical iOS releases can return the standard 164-byte App Attest
-- authenticator record without Apple's newer optional bundle/category
-- extensions. The cryptographic identity remains fully verified; only this
-- descriptive metadata is absent.

alter table private.app_attest_keys
  alter column bundle_version drop not null,
  alter column validation_category drop not null;

alter table private.app_attest_keys
  drop constraint if exists app_attest_keys_bundle_version_check,
  drop constraint if exists app_attest_keys_validation_category_check;

alter table private.app_attest_keys
  add constraint app_attest_keys_optional_metadata_check check (
    (bundle_version is null and validation_category is null)
    or (
      nullif(btrim(bundle_version), '') is not null
      and validation_category between 1 and 6
    )
  );

comment on column private.app_attest_keys.bundle_version is
  'Apple-reported optional App Attest bundle metadata. Null when the verified authenticator record carries no extension block.';

comment on column private.app_attest_keys.validation_category is
  'Apple-reported optional App Attest validation category. Null when the verified authenticator record carries no extension block.';
