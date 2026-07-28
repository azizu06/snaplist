export function shouldSkipGuestFirstRunForOfflineCi(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    env.GITHUB_ACTIONS === "true" &&
    env.SNAPLIST_OFFLINE_VERIFY === "1"
  );
}
