import type { CacheClaimAuthority, TtlCache } from "./comp-cache";

export type AuthorityRaceEvent =
  | { type: "owner-observed"; ownerToken: string | null }
  | { type: "claim-requested"; ownerToken: string }
  | { type: "claim-aborted"; ownerToken: string }
  | { type: "claim-settled"; ownerToken: string; committed: boolean };

type RedisSetOptions = { ex: number; nx?: true };

type AuthorityTransition = {
  claimKey: string;
  authorityKey: string;
  ownerToken: string;
  nextState: string;
  nextRaw: string;
};

type ScriptAwareRedisOptions = {
  beforeTransition?: (
    transition: AuthorityTransition,
  ) => void | Promise<void>;
};

function parseAuthority(raw: string | undefined): CacheClaimAuthority | null {
  return raw == null ? null : (JSON.parse(raw) as CacheClaimAuthority);
}

export function createScriptAwareAuthorityRedis(
  options: ScriptAwareRedisOptions = {},
) {
  const store = new Map<string, string>();

  const writeAuthority = (
    key: string,
    ownerToken: string,
    state: CacheClaimAuthority["state"],
  ) => {
    store.set(
      key,
      JSON.stringify({ ownerToken, state, updatedAt: Date.now() }),
    );
  };

  const client = {
    async set(key: string, value: string, setOptions: RedisSetOptions) {
      if (setOptions.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      const value = store.get(key);
      return value == null ? null : JSON.parse(value);
    },
    async eval(
      _script: string,
      keys: string[],
      args: Array<string | number>,
    ) {
      const [claimKey, authorityKey] = keys as [string, string];
      const [rawOwnerToken, rawNextState, rawNext] = args;
      const transition = {
        claimKey,
        authorityKey,
        ownerToken: String(rawOwnerToken),
        nextState: String(rawNextState),
        nextRaw: String(rawNext),
      };
      await options.beforeTransition?.(transition);

      const claim = parseAuthority(store.get(claimKey));
      const current = parseAuthority(
        store.get(authorityKey) ?? store.get(claimKey),
      );
      if (
        claim?.ownerToken !== transition.ownerToken ||
        current?.ownerToken !== transition.ownerToken ||
        (transition.nextState === "live" && current.state !== "live") ||
        (transition.nextState !== "live" &&
          transition.nextState !== "terminal")
      ) {
        return 0;
      }
      store.set(authorityKey, transition.nextRaw);
      return 1;
    },
  };

  return { client, writeAuthority };
}

type AuthorityCacheOptions<T> = {
  set?: TtlCache<T>["set"];
  terminateDelayMs?: number;
};

export function createAuthorityCacheFixture<T>(
  options: AuthorityCacheOptions<T> = {},
) {
  let claimOwner: string | null = null;
  let claimAuthority: CacheClaimAuthority | null = null;

  const cache: TtlCache<T> = {
    scope: "shared",
    get: async () => null,
    set: options.set ?? (async () => undefined),
    claim: async (_key, _signal, ownerToken) => {
      if (claimOwner != null) return false;
      claimOwner = ownerToken ?? "owner";
      claimAuthority = {
        ownerToken: claimOwner,
        state: "live",
        updatedAt: Date.now(),
      };
      return true;
    },
    getClaimOwner: async () => claimOwner,
    getClaimAuthority: async () =>
      claimAuthority == null ? null : { ...claimAuthority },
    refreshClaimAuthority: async (_key, ownerToken) => {
      if (
        claimAuthority == null ||
        claimAuthority.ownerToken !== ownerToken ||
        claimAuthority.state !== "live"
      ) {
        return false;
      }
      claimAuthority = {
        ownerToken,
        state: "live",
        updatedAt: Date.now(),
      };
      return true;
    },
    terminateClaimAuthority: async (_key, ownerToken) => {
      if (options.terminateDelayMs != null) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.terminateDelayMs),
        );
      }
      if (
        claimAuthority == null ||
        claimAuthority.ownerToken !== ownerToken
      ) {
        return false;
      }
      claimAuthority = {
        ownerToken,
        state: "terminal",
        updatedAt: Date.now(),
      };
      return true;
    },
  };

  return {
    cache,
    getAuthority: () =>
      claimAuthority == null ? null : { ...claimAuthority },
  };
}
