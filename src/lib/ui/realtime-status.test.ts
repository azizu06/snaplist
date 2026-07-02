import { describe, expect, it } from "vitest";
import {
  connectionAfterJoinTimeout,
  connectionFromChannelStatus,
} from "./realtime-status";

describe("connectionFromChannelStatus", () => {
  it("maps SUBSCRIBED to live", () => {
    expect(connectionFromChannelStatus("SUBSCRIBED")).toBe("live");
  });

  it.each(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"])(
    "maps %s to failed",
    (status) => {
      expect(connectionFromChannelStatus(status)).toBe("failed");
    },
  );

  it("treats unknown statuses as still connecting (honest default)", () => {
    expect(connectionFromChannelStatus("JOINING")).toBe("connecting");
    expect(connectionFromChannelStatus("")).toBe("connecting");
  });
});

describe("connectionAfterJoinTimeout", () => {
  it("degrades a still-connecting channel to failed", () => {
    expect(connectionAfterJoinTimeout("connecting")).toBe("failed");
  });

  it("leaves a joined channel alone", () => {
    expect(connectionAfterJoinTimeout("live")).toBe("live");
  });

  it("keeps an already-failed channel failed", () => {
    expect(connectionAfterJoinTimeout("failed")).toBe("failed");
  });
});
