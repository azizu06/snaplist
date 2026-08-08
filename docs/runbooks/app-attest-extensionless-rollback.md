# Extensionless App Attest rollback

The extensionless compatibility release stores `bundle_version` and
`validation_category` as a paired null only after the normal Apple certificate,
nonce, relying-party, AAGUID, key, receipt, and counter checks pass.

The previous server build rejects those rows at its private-store boundary. A
rollback is therefore fail closed: existing short-lived guest bearer tokens
continue only until their normal expiry, while new assertions for a paired-null
key are refused.

If the compatible server must be rolled back after it has accepted a paired-null
key:

1. Roll back the application deployment. Do not change the database constraint;
   it remains backward compatible with populated metadata rows.
2. Wait 30 minutes, the maximum verified guest capability lifetime, so no bearer
   minted from the affected attestation remains active.
3. In one reviewed transaction, count and delete only rows satisfying
   `bundle_version is null and validation_category is null` from
   `private.app_attest_keys`. Never delete populated metadata rows. The foreign
   key on guest claim handoffs cascades from the removed key.
4. Confirm no paired-null key remains. When the compatible server is restored,
   the client removes the server-missing local key, generates a replacement,
   and attests that new key.

The pgTAP contract `app_attest_optional_metadata.test.sql` proves that paired
nulls are accepted, asymmetric nulls are rejected, and cleanup permits a
different replacement key to be inserted. Never print key IDs, receipts,
attestation objects, capabilities, or bearer digests during rollback.

## Migration history

Production applied `20260808131433_app_attest_optional_metadata.sql` before its
PostgreSQL `CHECK`-`UNKNOWN` gap was identified, then applied the forward repair
`20260808131803_app_attest_optional_metadata_pair_integrity.sql`. Both applied
versions remain immutable in source; the second migration is intentionally not
deduplicated into the first.
