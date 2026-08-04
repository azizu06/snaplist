import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  skipIfStackUnreachable,
  stackReachable,
} from "@/test/supabase-stack";

let reachable = true;

beforeAll(async () => {
  reachable = await stackReachable();
});

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

describe("unreachable Supabase stack fixture", () => {
  it("only runs with a reachable stack", () => {
    expect.unreachable("the dead-port fixture must skip this assertion");
  });
});
