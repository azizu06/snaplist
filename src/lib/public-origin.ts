/**
 * One definition of "an origin the public internet can actually reach".
 *
 * Two callers depend on it for different reasons and must not disagree:
 * startup validation of `CLERK_AUTHORIZED_PARTIES` and `SNAPLIST_PUBLIC_ORIGIN`,
 * and the eBay picture origin that ends up inside a published listing. A weaker
 * second opinion at either site is how a value that startup rejects still
 * reaches eBay's fetcher.
 *
 * It lives here rather than in `env.ts` so importing the predicate does not
 * drag in Zod and the whole environment schema, whose module graph exists to
 * validate a process at startup rather than to answer one question about one
 * string.
 */
export function isPublicHttpsOrigin(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      return false;
    }

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;

    const ipv4 = hostname.split(".").map(Number);
    if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      return isPublicIpv4(ipv4);
    }

    if (!hostname.includes(":")) return true;

    const ipv6 = parseIpv6Hextets(hostname);
    if (!ipv6) return false;

    if (isIpv4EmbeddedIpv6(ipv6)) {
      return isPublicIpv4([
        ipv6[6] >> 8,
        ipv6[6] & 0xff,
        ipv6[7] >> 8,
        ipv6[7] & 0xff,
      ]);
    }

    return !(
      (ipv6[0] & 0xfe00) === 0xfc00
      || (ipv6[0] & 0xffc0) === 0xfe80
      || (ipv6[0] & 0xffc0) === 0xfec0
      || (ipv6[0] & 0xff00) === 0xff00
      || (ipv6[0] === 0x2001 && ipv6[1] === 0x0db8)
    );
  } catch {
    return false;
  }
}

function isPublicIpv4([first, second]: number[]): boolean {
  return !(
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224
  );
}

function parseIpv6Hextets(hostname: string): number[] | undefined {
  const parts = hostname.toLowerCase().split("::");
  if (parts.length > 2) return undefined;

  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const hextets = [...left, ...right];
  if (
    (parts.length === 1 && hextets.length !== 8)
    || (parts.length === 2 && hextets.length >= 8)
    || hextets.some((hextet) => !/^[0-9a-f]{1,4}$/.test(hextet))
  ) {
    return undefined;
  }

  const values = hextets.map((hextet) => Number.parseInt(hextet, 16));
  return parts.length === 1
    ? values
    : [...values.slice(0, left.length), ...Array(8 - values.length).fill(0), ...values.slice(left.length)];
}

function isIpv4EmbeddedIpv6(ipv6: number[]): boolean {
  return (
    ipv6.slice(0, 6).every((hextet) => hextet === 0)
    || (ipv6.slice(0, 5).every((hextet) => hextet === 0) && ipv6[5] === 0xffff)
    || (
      ipv6.slice(0, 4).every((hextet) => hextet === 0)
      && ipv6[4] === 0xffff
      && ipv6[5] === 0
    )
  );
}
