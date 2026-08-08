begin;

select extensions.plan(6);

select extensions.lives_ok(
  $$
    insert into private.app_attest_keys (
      key_id, app_id, environment, public_key_pem, receipt,
      assertion_counter, bundle_version, validation_category
    ) values (
      'pgtap-app-attest-null-pair',
      'TEAMID1234.dev.snaplist.ios',
      'production',
      '-----BEGIN PUBLIC KEY-----fixed',
      decode('01', 'hex'),
      0,
      null,
      null
    )
  $$,
  'a verified extensionless attestation persists an honestly absent metadata pair'
);

select extensions.lives_ok(
  $$
    insert into private.app_attest_keys (
      key_id, app_id, environment, public_key_pem, receipt,
      assertion_counter, bundle_version, validation_category
    ) values (
      'pgtap-app-attest-complete-pair',
      'TEAMID1234.dev.snaplist.ios',
      'production',
      '-----BEGIN PUBLIC KEY-----fixed',
      decode('01', 'hex'),
      0,
      '1',
      4
    )
  $$,
  'an extension-bearing attestation preserves its complete valid metadata pair'
);

select extensions.throws_ok(
  $$
    insert into private.app_attest_keys (
      key_id, app_id, environment, public_key_pem, receipt,
      assertion_counter, bundle_version, validation_category
    ) values (
      'pgtap-app-attest-missing-category',
      'TEAMID1234.dev.snaplist.ios',
      'production',
      '-----BEGIN PUBLIC KEY-----fixed',
      decode('01', 'hex'),
      0,
      '1',
      null
    )
  $$,
  '23514',
  null,
  'a bundle version without a validation category is rejected'
);

select extensions.throws_ok(
  $$
    insert into private.app_attest_keys (
      key_id, app_id, environment, public_key_pem, receipt,
      assertion_counter, bundle_version, validation_category
    ) values (
      'pgtap-app-attest-missing-version',
      'TEAMID1234.dev.snaplist.ios',
      'production',
      '-----BEGIN PUBLIC KEY-----fixed',
      decode('01', 'hex'),
      0,
      null,
      4
    )
  $$,
  '23514',
  null,
  'a validation category without a bundle version is rejected'
);

delete from private.app_attest_keys
where key_id = 'pgtap-app-attest-null-pair';

select extensions.is(
  (
    select count(*)
    from private.app_attest_keys
    where key_id = 'pgtap-app-attest-null-pair'
  ),
  0::bigint,
  'rollback cleanup removes the legacy-incompatible extensionless key'
);

select extensions.lives_ok(
  $$
    insert into private.app_attest_keys (
      key_id, app_id, environment, public_key_pem, receipt,
      assertion_counter, bundle_version, validation_category
    ) values (
      'pgtap-app-attest-replacement-key',
      'TEAMID1234.dev.snaplist.ios',
      'production',
      '-----BEGIN PUBLIC KEY-----fixed',
      decode('01', 'hex'),
      0,
      null,
      null
    )
  $$,
  'rollback cleanup permits the installation to attest a different replacement key after restoration'
);

select * from extensions.finish();

rollback;
