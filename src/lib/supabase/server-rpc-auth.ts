import "server-only";

export const SERVER_RPC_AUTH_HEADER = "x-snaplist-server-auth";

export function serverRpcHeaders(secret: string): Record<string, string> {
  const value = secret.trim();
  if (value.length < 32) {
    throw new Error("SERVER_RPC_SECRET must contain at least 32 characters.");
  }
  return { [SERVER_RPC_AUTH_HEADER]: value };
}
