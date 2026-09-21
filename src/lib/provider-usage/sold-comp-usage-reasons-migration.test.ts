import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The offline guard for the #1138 usage-reason migration.
 *
 * Two things are worth failing fast on without a database. First, the pgTAP
 * contract embeds this migration verbatim so a stale local stack still gets it
 * inside the contract's own transaction — round 1 of review caught exactly the
 * failure this prevents, a hand-written mirror that had already drifted from the
 * shipped function and was quietly gating on the wrong behaviour. Second, the
 * reason vocabulary and its ranking exist in two independent mirrors, TypeScript
 * and SQL, and a value accepted by one and refused by the other is a write that
 * fails in production and nowhere else.
 */
const MIGRATION_PATH =
  "supabase/migrations/20260921000000_sold_comp_usage_reasons.sql";

const migration = readFileSync(
  new URL(`../../../${MIGRATION_PATH}`, import.meta.url),
  "utf8",
);

const contract = readFileSync(
  new URL(
    "../../../supabase/tests/pipeline_run_provider_usage.test.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("sold-comp usage reason migration (#1138)", () => {
  it("is embedded in the pgTAP contract byte for byte", () => {
    const begin = `-- >>> BEGIN inline copy of ${MIGRATION_PATH}\n`;
    const end = `-- <<< END inline copy of ${MIGRATION_PATH}`;
    const start = contract.indexOf(begin);
    const stop = contract.indexOf(end);

    expect(start).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(start);
    expect(contract.slice(start + begin.length, stop)).toBe(migration);
  });

  it("ranks reasons in SQL exactly as the in-process tally does", () => {
    // The merge runs on every correction, retry, and queue redelivery. Taking
    // the last non-null reason instead of the highest-ranked one lets a
    // redelivery downgrade `provider-error` to `no-candidates` — a broken
    // provider silently becoming an item with no comps.
    expect(migration).toMatch(/create or replace function private\.sold_comp_reason_rank/);
    for (const [reason, rank] of [
      ["provider-error", 4],
      ["blocked", 3],
      ["no-anchors", 2],
      ["no-candidates", 1],
    ] as const) {
      expect(migration).toMatch(
        new RegExp(`when p_reason = '${reason}' then ${rank}`),
      );
    }
    expect(migration).toMatch(/when p_reason like 'all-rejected:%' then 2/);
    expect(migration).toMatch(
      /order by\s*\n\s*private\.sold_comp_reason_rank\(entry->>'reason'\) desc, entry_index desc/,
    );
  });

  it("accepts every reason the TypeScript vocabulary can produce, and no free text", () => {
    for (const reason of ["no-candidates", "no-anchors", "provider-error", "blocked"]) {
      expect(migration).toContain(`'${reason}'`);
    }
    expect(migration).toMatch(/\^all-rejected:\[a-z\]\[a-z-\]\{0,39\}\$/);
  });

  it("changes no tenancy surface", () => {
    // The record lives in an existing jsonb column, so this migration may widen
    // validators and one CHECK and nothing else. A grant or policy appearing
    // here would be a tenancy change riding on a telemetry fix.
    expect(migration).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(migration).not.toMatch(/grant\s+(select|insert|update|delete|all)\s+on\s+table/i);
    expect(migration).not.toMatch(/add column|drop column|create table/i);
    expect(migration).not.toMatch(/enable row level security|disable row level security/i);
  });
});
