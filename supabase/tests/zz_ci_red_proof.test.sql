-- TEMPORARY: deliberate failing contract used to prove the CI pgTAP job goes red.
-- Removed in the commit that follows; see issue #496.
begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
select ok(false, 'deliberate failure proving the pgTAP CI job fails the build');
select * from finish();
rollback;
