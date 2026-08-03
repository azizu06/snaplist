import { describe, expect, it } from "vitest";
import {
  assertDbRlsSuiteSelection,
  selectDbRlsSuites,
  type TestFile,
} from "./db-rls-suites";

describe("DB-backed RLS Vitest suite selection", () => {
  const files: TestFile[] = [
    {
      path: "src/lib/supabase/rls.test.ts",
      content: 'import { stackReachable } from "@/test/supabase-stack";',
    },
    { path: "src/lib/billing/ledger.rls.test.ts", content: "" },
    {
      path: "src/lib/pipeline/persist.test.ts",
      content: 'import { stackReachable } from "@/test/supabase-stack";',
    },
    {
      path: "src/test/fixtures/supabase-stack-unreachable.test.ts",
      content: 'import { stackReachable } from "@/test/supabase-stack";',
    },
    {
      path: "src/lib/pricing/router.test.ts",
      content: 'const importExample = \'import { stackReachable } from "@/test/supabase-stack";\';',
    },
  ];

  it("runs every RLS suite and every non-fixture shared-stack consumer", () => {
    expect(selectDbRlsSuites(files)).toEqual([
      "src/lib/billing/ledger.rls.test.ts",
      "src/lib/pipeline/persist.test.ts",
      "src/lib/supabase/rls.test.ts",
    ]);
  });

  it("rejects an empty selection when DB-backed candidates exist", () => {
    expect(() => assertDbRlsSuiteSelection(2, [])).toThrow(
      "DB-backed RLS suite selection found 2 candidates but selected none",
    );
  });
});
