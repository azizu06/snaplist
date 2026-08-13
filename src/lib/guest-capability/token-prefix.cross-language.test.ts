import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_CAPABILITY_TOKEN_PREFIX } from "./token-prefix";

const SWIFT_CONSTANT_PATH = join(
  process.cwd(),
  "ios/SnapList/AppAttest/AppAttestClient.swift",
);

function swiftGuestCapabilityTokenPrefix(): string {
  const source = readFileSync(SWIFT_CONSTANT_PATH, "utf8");
  const match = source.match(
    /enum GuestCapabilityToken\s*\{\s*static let prefix\s*=\s*"([^"]+)"/,
  );
  if (!match) {
    throw new Error(
      `Could not find GuestCapabilityToken.prefix in ${SWIFT_CONSTANT_PATH}.`,
    );
  }
  return match[1]!;
}

describe("guest capability token prefix", () => {
  it("agrees between the TypeScript and Swift boundaries", () => {
    expect(swiftGuestCapabilityTokenPrefix()).toBe(GUEST_CAPABILITY_TOKEN_PREFIX);
  });
});
