import {
  createHash,
  createHmac,
  hkdfSync,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { EbayOauthSession } from "@/lib/mobile-api/contract";
import {
  encryptSecret,
  parseEncryptionKey,
} from "@/lib/crypto/secretbox";
import { buildAuthorizeUrl, ebayApiBaseUrl } from "./oauth";
import {
  exchangeAuthorizationCode,
  fetchEbayIdentity,
  type EbayIdentity,
  type EbayTokenGrant,
} from "./oauth";

type Env = Record<string, string | undefined>;

export interface StoredMobileEbayOauthSession {
  sessionId: string;
  userId: string;
  expiresAt: string;
}

type MobileEbayOauthOutcome =
  | "connected"
  | "declined"
  | "cancelled"
  | "expired"
  | "failed";

export interface MobileEbayOauthSessionStore {
  createOrReplaySession(input: {
    proposedSessionId: string;
    userId: string;
    bearerToken: string;
    idempotencyKey: string;
  }): Promise<StoredMobileEbayOauthSession>;
  getSession(sessionId: string): Promise<StoredMobileEbayOauthSession | null>;
  finishSession(input: {
    sessionId: string;
    userId: string;
    outcome: "declined" | "cancelled" | "expired" | "failed";
    finishedAt: string;
  }): Promise<
    | { kind: "finished" | "replayed"; outcome: MobileEbayOauthOutcome }
    | { kind: "in_progress" }
    | { kind: "wrong_tenant" }
  >;
  beginSession(input: {
    sessionId: string;
    userId: string;
    startedAt: string;
  }): Promise<
    | { kind: "claimed"; leaseToken: string }
    | { kind: "replayed"; outcome: MobileEbayOauthOutcome }
    | { kind: "in_progress" }
    | { kind: "wrong_tenant" }
    | { kind: "expired" }
  >;
  completeSession(input: {
    sessionId: string;
    userId: string;
    leaseToken: string;
    ebayUserId: string;
    ebayUsername: string;
    refreshTokenEnc: string;
    accessTokenEnc: string;
    accessTokenExpiresAt: string;
    scopes: string[];
    completedAt: string;
  }): Promise<
    | { kind: "connected" | "wrong_tenant" }
    | { kind: "replayed"; outcome: MobileEbayOauthOutcome }
  >;
  failSession(input: {
    sessionId: string;
    userId: string;
    leaseToken: string;
    failedAt: string;
  }): Promise<
    | { kind: "finished" | "replayed"; outcome: MobileEbayOauthOutcome }
    | { kind: "wrong_tenant" }
  >;
}

export interface CreateMobileEbayOauthSessionInput {
  userId: string;
  bearerToken: string;
  idempotencyKey: string;
}

export interface MobileEbayOauthOperations {
  createSession(
    input: CreateMobileEbayOauthSessionInput,
  ): Promise<EbayOauthSession>;
  completeCallback(input: {
    state: string;
    code: string | null;
    error: string | null;
    errorDescription: string | null;
  }): Promise<{ redirectUrl: string }>;
}

function mobileReturnUrl(env: Env, result: string): string {
  const configured = env.EBAY_MOBILE_OAUTH_RETURN_URL;
  if (!configured) {
    throw new Error("EBAY_MOBILE_OAUTH_RETURN_URL is not configured.");
  }
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(
      "EBAY_MOBILE_OAUTH_RETURN_URL must be an HTTPS universal link without credentials or a fragment.",
    );
  }
  url.searchParams.set("result", result);
  return url.toString();
}

function assertSandboxOnly(env: Env): void {
  const url = new URL(ebayApiBaseUrl(env));
  if (
    url.origin !== "https://api.sandbox.ebay.com" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Mobile eBay OAuth is restricted to Sandbox.");
  }
}

function mobileProviderEnv(env: Env): Env {
  const mobileRuName = env.EBAY_MOBILE_RU_NAME?.trim();
  if (!mobileRuName) {
    throw new Error(
      "EBAY_MOBILE_RU_NAME is not configured for the Sandbox mobile callback.",
    );
  }
  return { ...env, EBAY_RU_NAME: mobileRuName };
}

function tenantBinding(userId: string): string {
  return createHash("sha256")
    .update("snaplist:ebay-mobile-oauth-tenant:v1\0")
    .update(userId)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

function stateSigningKey(env: Env): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      parseEncryptionKey(env.EBAY_TOKEN_ENCRYPTION_KEY),
      Buffer.alloc(0),
      Buffer.from("snaplist:ebay-mobile-oauth-state:v1"),
      32,
    ),
  );
}

function signStatePayload(payload: string, env: Env): string {
  return createHmac("sha256", stateSigningKey(env))
    .update(payload)
    .digest("base64url");
}

function encodeState(session: StoredMobileEbayOauthSession, env: Env): string {
  const sessionId = z.string().uuid().parse(session.sessionId);
  const encodedSessionId = Buffer.from(sessionId, "utf8").toString("base64url");
  const payload = `v1.${encodedSessionId}.${tenantBinding(session.userId)}`;
  return `${payload}.${signStatePayload(payload, env)}`;
}

const canonicalBase64UrlPattern = /^[A-Za-z0-9_-]+$/;

function decodeCanonicalBase64Url(
  value: string,
  expectedByteLength: number,
): Buffer | null {
  if (!canonicalBase64UrlPattern.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== expectedByteLength
    || decoded.toString("base64url") !== value
  ) {
    return null;
  }
  return decoded;
}

function decodeState(state: string): {
  sessionId: string;
  tenantBinding: string;
  payload: string;
  signature: string;
} | null {
  const [version, sessionId, boundTenant, signature, ...rest] = state.split(".");
  if (
    version !== "v1" ||
    !sessionId ||
    !boundTenant ||
    !signature ||
    rest.length > 0
  ) {
    return null;
  }
  const sessionIdBytes = decodeCanonicalBase64Url(sessionId, 36);
  const tenantBytes = decodeCanonicalBase64Url(boundTenant, 16);
  const signatureBytes = decodeCanonicalBase64Url(signature, 32);
  if (!sessionIdBytes || !tenantBytes || !signatureBytes) return null;
  const parsedSessionId = z.string().uuid().safeParse(
    sessionIdBytes.toString("utf8"),
  );
  if (
    !parsedSessionId.success
    || parsedSessionId.data !== parsedSessionId.data.toLowerCase()
  ) {
    return null;
  }
  return {
    sessionId: parsedSessionId.data,
    tenantBinding: boundTenant,
    payload: `${version}.${sessionId}.${boundTenant}`,
    signature,
  };
}

function equalCanonicalBase64Url(
  left: string,
  right: string,
  expectedByteLength: number,
): boolean {
  const leftBytes = decodeCanonicalBase64Url(left, expectedByteLength);
  const rightBytes = decodeCanonicalBase64Url(right, expectedByteLength);
  return Boolean(
    leftBytes
    && rightBytes
    && timingSafeEqual(leftBytes, rightBytes),
  );
}

export function createMobileEbayOauthOperations(input: {
  store: MobileEbayOauthSessionStore;
  env?: () => Env;
  now?: () => number;
  randomUUID?: () => string;
  exchangeCode?: (code: string, env: Env) => Promise<EbayTokenGrant>;
  fetchIdentity?: (
    accessToken: string,
    env: Env,
  ) => Promise<EbayIdentity | null>;
}): MobileEbayOauthOperations {
  const readEnv = input.env ?? (() => process.env);
  const now = input.now ?? Date.now;
  const nextUUID = input.randomUUID ?? randomUUID;
  const exchangeCode = input.exchangeCode ?? ((code, env) =>
    exchangeAuthorizationCode(code, env));
  const resolveIdentity = input.fetchIdentity ?? ((accessToken, env) =>
    fetchEbayIdentity(accessToken, env));

  return {
    async createSession({ userId, bearerToken, idempotencyKey }) {
      const env = mobileProviderEnv(readEnv());
      assertSandboxOnly(env);
      const stored = await input.store.createOrReplaySession({
        proposedSessionId: nextUUID(),
        userId,
        bearerToken,
        idempotencyKey,
      });
      return {
        sessionId: stored.sessionId,
        authorizationUrl: buildAuthorizeUrl(env, encodeState(stored, env)),
        expiresAt: stored.expiresAt,
      };
    },
    async completeCallback({ state, code, error }) {
      const configuredEnv = readEnv();
      let env: Env;
      try {
        env = mobileProviderEnv(configuredEnv);
        assertSandboxOnly(env);
      } catch {
        return { redirectUrl: mobileReturnUrl(configuredEnv, "failed") };
      }
      const decoded = decodeState(state);
      if (!decoded) {
        return { redirectUrl: mobileReturnUrl(env, "invalid_state") };
      }
      if (!equalCanonicalBase64Url(
        decoded.signature,
        signStatePayload(decoded.payload, env),
        32,
      )) {
        return { redirectUrl: mobileReturnUrl(env, "invalid_state") };
      }
      const session = await input.store.getSession(decoded.sessionId);
      if (!session) {
        return { redirectUrl: mobileReturnUrl(env, "invalid_state") };
      }
      if (!equalCanonicalBase64Url(
        decoded.tenantBinding,
        tenantBinding(session.userId),
        16,
      )) {
        return { redirectUrl: mobileReturnUrl(env, "wrong_tenant") };
      }
      const finishedAt = new Date(now()).toISOString();
      const outcome = error === "access_denied"
        ? "declined"
        : error
          ? "failed"
          : !code
          ? "cancelled"
          : null;
      if (!outcome) {
        if (!code || error) {
          return { redirectUrl: mobileReturnUrl(env, "failed") };
        }
        const startedAt = new Date(now()).toISOString();
        const begin = await input.store.beginSession({
          sessionId: session.sessionId,
          userId: session.userId,
          startedAt,
        });
        if (begin.kind === "wrong_tenant") {
          return { redirectUrl: mobileReturnUrl(env, "wrong_tenant") };
        }
        if (begin.kind === "expired") {
          return { redirectUrl: mobileReturnUrl(env, "expired") };
        }
        if (begin.kind === "in_progress") {
          return { redirectUrl: mobileReturnUrl(env, "in_progress") };
        }
        if (begin.kind === "replayed") {
          return { redirectUrl: mobileReturnUrl(env, begin.outcome) };
        }
        try {
          const grant = await exchangeCode(code, env);
          const identity = await resolveIdentity(grant.accessToken, env);
          if (!identity) {
            throw new Error("eBay Sandbox identity could not be verified.");
          }
          const key = parseEncryptionKey(env.EBAY_TOKEN_ENCRYPTION_KEY);
          const complete = await input.store.completeSession({
            sessionId: session.sessionId,
            userId: session.userId,
            leaseToken: begin.leaseToken,
            ebayUserId: identity.userId,
            ebayUsername: identity.username,
            refreshTokenEnc: encryptSecret(grant.refreshToken, key),
            accessTokenEnc: encryptSecret(grant.accessToken, key),
            accessTokenExpiresAt: new Date(
              grant.accessTokenExpiresAt,
            ).toISOString(),
            scopes: grant.scopes,
            completedAt: new Date(now()).toISOString(),
          });
          return {
            redirectUrl: mobileReturnUrl(
              env,
              complete.kind === "wrong_tenant"
                ? "wrong_tenant"
                : complete.kind === "replayed"
                  ? complete.outcome
                  : "connected",
            ),
          };
        } catch {
          try {
            const failure = await input.store.failSession({
              sessionId: session.sessionId,
              userId: session.userId,
              leaseToken: begin.leaseToken,
              failedAt: new Date(now()).toISOString(),
            });
            return {
              redirectUrl: mobileReturnUrl(
                env,
                failure.kind === "wrong_tenant"
                  ? "wrong_tenant"
                  : failure.outcome,
              ),
            };
          } catch {
            return { redirectUrl: mobileReturnUrl(env, "failed") };
          }
        }
      }
      const finish = await input.store.finishSession({
        sessionId: session.sessionId,
        userId: session.userId,
        outcome,
        finishedAt,
      });
      return {
        redirectUrl: mobileReturnUrl(
          env,
          finish.kind === "wrong_tenant"
            ? "wrong_tenant"
            : finish.kind === "in_progress"
              ? "in_progress"
              : finish.outcome,
        ),
      };
    },
  };
}
