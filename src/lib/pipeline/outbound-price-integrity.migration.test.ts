import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260713220100_outbound_price_revision_guards.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("outbound price revision migration", () => {
  it("returns the seller override from the locked publish claim snapshot", () => {
    const publishFunction = migration.match(
      /create\s+or\s+replace\s+function\s+public\.begin_ebay_publish[\s\S]*?\$\$;/i,
    )?.[0];

    expect(publishFunction).toMatch(
      /update\s+public\.items[\s\S]*returning\s+condition,\s*photos,\s*price_override[\s\S]*into\s+v_condition,\s*v_photos,\s*v_price_override/i,
    );
    expect(publishFunction).toMatch(
      /'priceOverride'\s*,\s*v_price_override/i,
    );
  });

  it("rejects every seller price write while an eBay publish owns the item", () => {
    expect(migration).toMatch(
      /before\s+update\s+of\s+price_override\s+on\s+public\.items/i,
    );
    const guardFunction = migration.match(
      /create\s+or\s+replace\s+function\s+public\.reject_price_override_while_ebay_publishing[\s\S]*?\$\$;/i,
    )?.[0];
    expect(guardFunction).toMatch(
      /new\.price_override\s+is\s+distinct\s+from\s+old\.price_override/i,
    );
    expect(guardFunction).toMatch(
      /listing\.item_id\s*=\s*old\.id[\s\S]*listing\.user_id\s*=\s*old\.user_id[\s\S]*ebay_status\s+is\s+not\s+distinct\s+from\s+'publishing'/i,
    );
  });

  it("persists export packs only when content and seller price revisions still match", () => {
    const persistFunction = migration.match(
      /create\s+or\s+replace\s+function\s+public\.persist_export_packs[\s\S]*?\$\$;/i,
    )?.[0];

    expect(persistFunction).toMatch(/p_expected_review_revision\s+uuid/i);
    expect(persistFunction).toMatch(
      /review_content_revision\s+is\s+not\s+distinct\s+from\s+p_source_review_revision/i,
    );
    expect(persistFunction).toMatch(
      /review_revision\s+is\s+not\s+distinct\s+from\s+p_expected_review_revision/i,
    );
    expect(persistFunction).toMatch(/security\s+invoker/i);
    expect(persistFunction).toMatch(/user_id\s*=\s*v_user_id/i);
  });
});
