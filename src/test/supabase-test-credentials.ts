type SupabaseTestEnvironment = Record<string, string | undefined>;

/**
 * Tenant-bound server tests use the same two-part authorization as production:
 * a seller JWT in Authorization and a current secret API key in apikey.
 * The legacy service-role JWT bypasses RLS but cannot prove the server-key half
 * of that contract.
 */
export function resolveTenantServerTestApiKey(
  env: SupabaseTestEnvironment = process.env,
): string | undefined {
  const candidates = [
    env.SUPABASE_SECRET_KEY,
    env.SUPABASE_SERVICE_ROLE_KEY,
  ].filter((key): key is string => Boolean(key));
  const secretApiKey = candidates.find((key) => key.startsWith("sb_secret_"));

  if (secretApiKey) return secretApiKey;
  if (candidates.length === 0) return undefined;

  throw new Error(
    "Tenant-bound server tests require the current Supabase SECRET_KEY (sb_secret_...), not the legacy SERVICE_ROLE_KEY JWT.",
  );
}
