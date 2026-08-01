import { createPrivateKey, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import type {
  DeviceCheckAdapter,
  DeviceCheckAmbiguousReason,
  DeviceCheckQueryResult,
  DeviceCheckUpdateResult,
} from "./device-check-adapter";

const HOSTS = {
  development: "https://api.development.devicecheck.apple.com",
  production: "https://api.devicecheck.apple.com",
} as const;

/**
 * Apple's documented answer for a device it has never recorded bits for. It
 * arrives as HTTP 200 with this exact plain-text body rather than JSON.
 */
const UNTOUCHED_DEVICE_BODY = "Failed to find bit state";

const AMBIGUOUS_BY_STATUS: Readonly<Record<number, DeviceCheckAmbiguousReason>> = {
  400: "malformed_response",
  401: "unauthorized",
  403: "unauthorized",
  405: "malformed_response",
  429: "throttled",
  500: "server_error",
  502: "server_error",
  503: "unavailable",
  504: "timeout",
};

export interface AppleDeviceCheckOptions {
  environment: "development" | "production";
  fetch?: typeof globalThis.fetch;
  /** DeviceCheck key identifier from the Apple developer portal. */
  keyId: string;
  now?: () => Date;
  /** PKCS#8 PEM for the DeviceCheck private key. Supplied by env, never committed. */
  privateKeyPem: string;
  teamId: string;
  timeoutMs?: number;
  transactionId?: () => string;
}

function ambiguousFor(status: number): DeviceCheckAmbiguousReason {
  return AMBIGUOUS_BY_STATUS[status] ?? "server_error";
}

function parseQueryBody(body: string): DeviceCheckQueryResult {
  if (body.trim() === UNTOUCHED_DEVICE_BODY) {
    return { bit0: false, bit1: false, status: "resolved" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { reason: "malformed_response", status: "ambiguous" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { bit0?: unknown }).bit0 !== "boolean" ||
    typeof (parsed as { bit1?: unknown }).bit1 !== "boolean"
  ) {
    // An answer we cannot read is not evidence that the device is unused.
    return { reason: "malformed_response", status: "ambiguous" };
  }
  const bits = parsed as { bit0: boolean; bit1: boolean };
  return { bit0: bits.bit0, bit1: bits.bit1, status: "resolved" };
}

export function createAppleDeviceCheckAdapter(
  options: AppleDeviceCheckOptions,
): DeviceCheckAdapter {
  const host = HOSTS[options.environment];
  const now = options.now ?? (() => new Date());
  const doFetch = options.fetch ?? globalThis.fetch;
  const newTransactionId = options.transactionId ?? randomUUID;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signingKey = createPrivateKey(options.privateKeyPem);

  async function authorization(): Promise<string> {
    const issuedAt = Math.floor(now().getTime() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: options.keyId, typ: "JWT" })
      .setIssuer(options.teamId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(signingKey);
    return `Bearer ${token}`;
  }

  /**
   * Performs one Apple call. `deviceToken` lives only in the request body and is
   * never returned, logged, or attached to an error.
   */
  async function call(
    path: "query_two_bits" | "update_two_bits",
    body: Record<string, unknown>,
  ): Promise<{ body: string; status: number } | { reason: DeviceCheckAmbiguousReason }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${host}/v1/${path}`, {
        body: JSON.stringify({
          ...body,
          timestamp: now().getTime(),
          transaction_id: newTransactionId(),
        }),
        headers: {
          authorization: await authorization(),
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });
      return { body: await response.text(), status: response.status };
    } catch {
      // Deliberately swallows the cause: it can carry the request body.
      return { reason: "timeout" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async queryTwoBits({ deviceToken }): Promise<DeviceCheckQueryResult> {
      const result = await call("query_two_bits", { device_token: deviceToken });
      if ("reason" in result) return { reason: result.reason, status: "ambiguous" };
      if (result.status !== 200) {
        return { reason: ambiguousFor(result.status), status: "ambiguous" };
      }
      return parseQueryBody(result.body);
    },

    async updateTwoBits({ bit0, bit1, deviceToken }): Promise<DeviceCheckUpdateResult> {
      const result = await call("update_two_bits", {
        bit0,
        bit1,
        device_token: deviceToken,
      });
      if ("reason" in result) return { reason: result.reason, status: "ambiguous" };
      if (result.status !== 200) {
        return { reason: ambiguousFor(result.status), status: "ambiguous" };
      }
      return { status: "updated" };
    },
  };
}
