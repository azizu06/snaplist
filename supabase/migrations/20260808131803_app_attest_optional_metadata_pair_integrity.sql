-- PostgreSQL CHECK constraints accept UNKNOWN, so repeat the optional metadata
-- invariant with explicit non-null requirements in the populated branch.

alter table private.app_attest_keys
  drop constraint if exists app_attest_keys_optional_metadata_check;

alter table private.app_attest_keys
  add constraint app_attest_keys_optional_metadata_check check (
    (bundle_version is null and validation_category is null)
    or (
      bundle_version is not null
      and validation_category is not null
      and nullif(btrim(bundle_version), '') is not null
      and validation_category between 1 and 6
    )
  );
