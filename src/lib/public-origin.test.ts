import { describe, expect, it } from "vitest";
import { isPublicHttpsOrigin } from "./public-origin";

/**
 * `isPublicHttpsOrigin` is the one predicate `env.ts` (CLERK_AUTHORIZED_PARTIES,
 * SNAPLIST_PUBLIC_ORIGIN) and the eBay picture-origin gate both rely on to agree
 * on what counts as public — see the module's own doc comment. It had no direct
 * unit test file; env.test.ts only exercises it indirectly through a handful of
 * IPv4-mapped-IPv6 and special-IPv6 cases reached via full env parsing.
 */

describe("isPublicHttpsOrigin", () => {
  it("accepts a plain public https origin with no path/query/hash", () => {
    expect(isPublicHttpsOrigin("https://app.snaplist.example")).toBe(true);
  });

  it("accepts a public IPv4 host", () => {
    expect(isPublicHttpsOrigin("https://8.8.8.8")).toBe(true);
  });

  it.each([
    "http://app.snaplist.example",
    "https://user@app.snaplist.example",
    "https://user:pass@app.snaplist.example",
    "https://app.snaplist.example/path",
    "https://app.snaplist.example?query=1",
    "https://app.snaplist.example#hash",
    "not a url",
  ])("rejects %s", (candidate) => {
    expect(isPublicHttpsOrigin(candidate)).toBe(false);
  });

  it.each(["https://localhost", "https://foo.localhost"])(
    "rejects localhost host %s",
    (candidate) => {
      expect(isPublicHttpsOrigin(candidate)).toBe(false);
    },
  );

  it.each([
    ["0.0.0.0", "this-network"],
    ["10.1.2.3", "10.0.0.0/8 private-use"],
    ["127.0.0.1", "loopback"],
    ["169.254.1.1", "link-local"],
    ["172.16.0.1", "172.16.0.0/12 private-use"],
    ["172.31.255.255", "172.16.0.0/12 private-use upper bound"],
    ["192.168.1.1", "192.168.0.0/16 private-use"],
    ["100.64.0.1", "100.64.0.0/10 carrier-grade NAT (RFC 6598)"],
    ["100.100.100.100", "100.64.0.0/10 carrier-grade NAT (RFC 6598), mid-range"],
    ["224.0.0.1", "224.0.0.0/4 multicast"],
    ["240.0.0.1", "240.0.0.0/4 reserved"],
    ["255.255.255.255", "broadcast"],
  ])("rejects non-public IPv4 host %s (%s)", (host) => {
    expect(isPublicHttpsOrigin(`https://${host}`)).toBe(false);
  });

  it.each([
    "171.255.255.255",
    "100.63.255.255",
    "100.128.0.0",
    "223.255.255.255",
  ])("accepts public IPv4 host just outside every excluded range: %s", (host) => {
    expect(isPublicHttpsOrigin(`https://${host}`)).toBe(true);
  });

  it("accepts a public IPv6 host", () => {
    expect(isPublicHttpsOrigin("https://[2001:4860:4860::8888]")).toBe(true);
  });

  it.each([
    "https://[::1]",
    "https://[fc00::1]",
    "https://[fe80::1]",
    "https://[ff02::1]",
    "https://[2001:db8::1]",
  ])("rejects non-public IPv6 host %s", (candidate) => {
    expect(isPublicHttpsOrigin(candidate)).toBe(false);
  });

  it.each([
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:10.0.0.1]",
    "https://[::ffff:100.64.0.1]",
  ])("rejects a non-public IPv4-mapped IPv6 host %s", (candidate) => {
    expect(isPublicHttpsOrigin(candidate)).toBe(false);
  });
});
