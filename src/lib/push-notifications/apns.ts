import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import type {
  ApnsEnvironment,
  ApnsSendOutcome,
  ApnsSendRequest,
  ApnsSender,
} from "./sender";

/**
 * The HTTP implementation behind the APNs seam (#891).
 *
 * Two facts about the credential shape everything here. The key is registered
 * for Sandbox and Production together, so the host cannot be configuration: it
 * is a property of the device, decided by the `aps-environment` entitlement of
 * the build that produced the token and carried on the row. And the key is Team
 * Scoped, valid for every bundle in the team, so the topic is the bundle id
 * from configuration rather than anything the credential implies.
 *
 * Getting either wrong is silent. Apple accepts a notification addressed to the
 * wrong host and simply never delivers it.
 */

const HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/**
 * Apple refuses a provider token older than an hour and refuses a provider that
 * re-signs more often than every twenty minutes. Forty-five leaves room for a
 * slow send and for clock skew at both ends.
 */
const PROVIDER_TOKEN_LIFETIME_MS = 45 * 60 * 1000;

/** Apple's own name for a token that no longer addresses an installed app. */
const GONE_REASONS = new Set(["Unregistered", "BadDeviceToken"]);

export interface ApnsConfig {
  bundleId: string;
  keyId: string;
  /** PKCS8 PEM, read from disk at startup. Never logged, never serialised. */
  privateKeyPem: string;
  teamId: string;
}

export interface ApnsHttpRequest {
  url: string;
  headers: Record<string, string> & { authorization: string };
  body: string;
}

export interface ApnsHttpResponse {
  status: number;
  body: string;
}

export interface ApnsTransport {
  send(request: ApnsHttpRequest): Promise<ApnsHttpResponse>;
}

/**
 * Reads the provider configuration, or refuses to start.
 *
 * All four names are reported together. A sender that fails on the first
 * missing variable makes an operator restart four times to learn what it needs,
 * and each of those restarts looks like a different fault.
 *
 * There is deliberately no degraded mode. A push path that starts without a
 * credential and quietly delivers nothing is green in every test and dead on
 * the device, which is the failure this seam exists to make impossible.
 */
export function resolveApnsConfig(
  env: Record<string, string | undefined>,
  readKey: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ApnsConfig {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  const keyPath = env.APNS_AUTH_KEY_PATH?.trim();

  const missing = [
    ["APNS_KEY_ID", keyId],
    ["APNS_TEAM_ID", teamId],
    ["APNS_BUNDLE_ID", bundleId],
    ["APNS_AUTH_KEY_PATH", keyPath],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Seller push is not configured. Missing: ${missing.join(", ")}.`,
    );
  }

  let privateKeyPem: string;
  try {
    privateKeyPem = readKey(keyPath!);
  } catch (error) {
    // The path, never the contents. A key that failed to load is still a key.
    throw new Error(
      `Seller push could not read APNS_AUTH_KEY_PATH (${keyPath}): ${
        error instanceof Error ? error.name : typeof error
      }.`,
    );
  }
  if (!privateKeyPem.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "APNS_AUTH_KEY_PATH does not point at an APNs auth key. Apple issues it as a PKCS8 .p8 file.",
    );
  }

  return { bundleId: bundleId!, keyId: keyId!, privateKeyPem, teamId: teamId! };
}

export function createHttpApnsSender(input: {
  config: ApnsConfig;
  transport: ApnsTransport;
  now?: () => number;
}): ApnsSender {
  const now = input.now ?? Date.now;
  let cached: { token: string; mintedAt: number } | undefined;

  async function providerToken(): Promise<string> {
    const at = now();
    if (cached && at - cached.mintedAt < PROVIDER_TOKEN_LIFETIME_MS) {
      return cached.token;
    }
    const key = await importPKCS8(input.config.privateKeyPem, "ES256");
    const token = await new SignJWT({ iss: input.config.teamId })
      .setProtectedHeader({ alg: "ES256", kid: input.config.keyId })
      .setIssuedAt(Math.floor(at / 1000))
      .sign(key);
    cached = { token, mintedAt: at };
    return token;
  }

  return {
    async send(request: ApnsSendRequest): Promise<ApnsSendOutcome> {
      let response: ApnsHttpResponse;
      try {
        response = await input.transport.send({
          url: `${HOSTS[request.device.environment]}/3/device/${request.device.token}`,
          headers: {
            authorization: `bearer ${await providerToken()}`,
            "apns-topic": input.config.bundleId,
            "apns-push-type": "alert",
            "apns-collapse-id": request.collapseId,
            // The seller is being told about work that already finished, so it
            // is worth waking the screen for; a listing they never see is the
            // thing this feature exists to prevent.
            "apns-priority": "10",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            aps: {
              alert: { title: request.message.title, body: request.message.body },
              sound: "default",
            },
            // Read by the app when it is open and iOS asks whether to draw the
            // system banner. The collapse id says the same thing, but it rides
            // an APNs header the device never sees. Nothing about the seller
            // is in here: it is one of two fixed words.
            moment: request.moment,
          }),
        });
      } catch (error) {
        // Only the shape. A transport failure can carry provider text, and this
        // path rides on the seller's own generated item copy.
        return {
          outcome: "failed",
          reason: error instanceof Error ? error.name : "apns_transport_error",
        };
      }

      if (response.status === 200) return { outcome: "delivered" };

      const reason = appleReason(response.body);
      if (reason && GONE_REASONS.has(reason)) return { outcome: "deviceGone" };
      return { outcome: "failed", reason: reason ?? `apns_status_${response.status}` };
    },
  };
}

/**
 * Apple explains a refusal in a JSON `reason`, and the status alone does not
 * separate the cases that matter: 400 covers both a dead token and a malformed
 * payload, and deleting a device row for the second would be wrong.
 */
function appleReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long one notification may take before it is treated as failed.
 *
 * A refusal is easy. Silence is the dangerous case: a connection Apple accepts
 * and then never answers on emits no error and no close, so without a deadline
 * the send never settles. The dispatcher awaits the send, the pipeline worker
 * awaits the dispatcher, and one stalled socket holds a whole tick until the
 * platform kills the invocation. "A send that fails is logged and dropped, and
 * never blocks the pipeline" is only true if not answering counts as failing.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Named, because the sender reports `error.name` as the reason it dropped. */
class ApnsRequestTimeoutError extends Error {
  override readonly name = "ApnsRequestTimeout";
}

/**
 * The real transport. APNs speaks HTTP/2 only, which `fetch` does not, so this
 * is `node:http2` directly. Sessions are kept per host and reopened when Apple
 * closes one, because a connection per notification is what Apple throttles.
 */
export function createApnsHttp2Transport(
  options: { requestTimeoutMs?: number } = {},
): ApnsTransport {
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const sessions = new Map<string, ClientHttp2Session>();

  function sessionFor(origin: string): ClientHttp2Session {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(origin);
    session.on("close", () => sessions.delete(origin));
    session.on("error", () => sessions.delete(origin));
    sessions.set(origin, session);
    return session;
  }

  return {
    send(request) {
      const url = new URL(request.url);
      return new Promise((resolve, reject) => {
        const session = sessionFor(url.origin);
        const stream = session.request({
          ":method": "POST",
          ":path": url.pathname,
          ...request.headers,
        });
        let status = 0;
        let body = "";
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          finish();
        };
        const timer = setTimeout(() => {
          settle(() => {
            // The session, not just the stream. A connection that accepted a
            // request and went silent will do the same to the next one, and it
            // is pooled: leaving it in place would stall every later push too.
            // Destroying it emits `close`, which evicts it here.
            session.destroy();
            reject(new ApnsRequestTimeoutError("APNs did not answer in time."));
          });
        }, timeoutMs);
        // Node keeps the process alive for a pending timer, and this one
        // outlives nothing: the request settles first in every healthy case.
        timer.unref?.();
        stream.setEncoding("utf8");
        stream.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        stream.on("data", (chunk: string) => {
          body += chunk;
        });
        stream.on("end", () => settle(() => resolve({ status, body })));
        stream.on("error", (error) => settle(() => reject(error)));
        stream.end(request.body);
      });
    },
  };
}
