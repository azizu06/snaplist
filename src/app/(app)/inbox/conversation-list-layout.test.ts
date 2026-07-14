import { describe, expect, it } from "vitest";

import { conversationRowClassName } from "./conversation-list";

describe("conversationRowClassName", () => {
  it("constrains each conversation row to the mobile viewport", () => {
    const classes = conversationRowClassName(false).split(/\s+/);

    expect(classes).toEqual(
      expect.arrayContaining(["min-w-0", "w-full", "max-w-full", "overflow-hidden"]),
    );
  });
});
