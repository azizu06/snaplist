import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AUTO_REPLY_DEFAULT,
  AUTOPILOT_DEFAULT,
  getAutoReplyEnabled,
  getAutopilotEnabled,
  setAutoReplyEnabled,
  setAutopilotEnabled,
} from "./user-settings";

/**
 * Offline unit tests for the user-settings access helpers (issue #12), using a
 * minimal fake Supabase client. The RLS behaviour of the real table is covered
 * separately against the local stack (user-settings.rls.test.ts).
 */

type Row = { autopilot_enabled: boolean } | null;

/** Fake of exactly the query surface getAutopilotEnabled uses. */
function fakeReadClient(result: { data: Row; error: { message: string } | null }) {
  const calls: { table?: string; column?: string; eqArgs?: [string, unknown] } = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        select(column: string) {
          calls.column = column;
          return {
            eq(col: string, value: unknown) {
              calls.eqArgs = [col, value];
              return {
                maybeSingle: async () => result,
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

/** Fake of exactly the surface setAutopilotEnabled uses. */
function fakeWriteClient(result: { error: { message: string } | null }) {
  const calls: { table?: string; payload?: unknown; options?: unknown } = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        upsert: async (payload: unknown, options: unknown) => {
          calls.payload = payload;
          calls.options = options;
          return result;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("getAutopilotEnabled", () => {
  it("returns the stored value when a settings row exists", async () => {
    const { client, calls } = fakeReadClient({
      data: { autopilot_enabled: false },
      error: null,
    });
    await expect(getAutopilotEnabled(client, "user-1")).resolves.toBe(false);
    expect(calls.table).toBe("user_settings");
    expect(calls.eqArgs).toEqual(["user_id", "user-1"]);
  });

  it("defaults to enabled when the user has no settings row", async () => {
    const { client } = fakeReadClient({ data: null, error: null });
    await expect(getAutopilotEnabled(client, "user-1")).resolves.toBe(
      AUTOPILOT_DEFAULT,
    );
    expect(AUTOPILOT_DEFAULT).toBe(true);
  });

  it("throws on a query error instead of silently marking items ready against the user's wishes", async () => {
    const { client } = fakeReadClient({
      data: null,
      error: { message: "boom" },
    });
    await expect(getAutopilotEnabled(client, "user-1")).rejects.toThrow(/boom/);
  });
});

describe("setAutopilotEnabled", () => {
  it("upserts the per-user row keyed on user_id", async () => {
    const { client, calls } = fakeWriteClient({ error: null });
    await setAutopilotEnabled(client, "user-1", false);
    expect(calls.table).toBe("user_settings");
    expect(calls.payload).toEqual({ user_id: "user-1", autopilot_enabled: false });
    expect(calls.options).toEqual({ onConflict: "user_id" });
  });

  it("throws on a write error", async () => {
    const { client } = fakeWriteClient({ error: { message: "denied" } });
    await expect(setAutopilotEnabled(client, "user-1", true)).rejects.toThrow(
      /denied/,
    );
  });
});

describe("automatic buyer-reply preference", () => {
  it("defaults to disabled when the seller has no settings row", async () => {
    const { client } = fakeReadClient({ data: null, error: null });
    await expect(getAutoReplyEnabled(client, "user-1")).resolves.toBe(false);
    expect(AUTO_REPLY_DEFAULT).toBe(false);
  });

  it("stores the one tenant-scoped master toggle", async () => {
    const { client, calls } = fakeWriteClient({ error: null });
    await setAutoReplyEnabled(client, "user-1", true);
    expect(calls.payload).toEqual({ user_id: "user-1", auto_reply_enabled: true });
    expect(calls.options).toEqual({ onConflict: "user_id" });
  });
});
