/**
 * Realtime connection vocabulary for surfaces riding a Supabase Realtime
 * channel (live inbox, notification bell). The subscribe callback's raw
 * channel statuses reduce to three honest UI states:
 *
 *   - `connecting` — the channel hasn't joined yet (initial state / retrying).
 *   - `live`       — joined; events are flowing.
 *   - `failed`     — the channel errored, timed out, closed, or stayed
 *                    un-joined past the join timeout. The UI must stop
 *                    claiming "Connecting…" and offer a quiet retry.
 *
 * Pure functions so the state machine is unit-tested directly (the suite has
 * no DOM harness); the components only wire timers and setState around them.
 */

export type RealtimeConnectionState = "connecting" | "live" | "failed";

/** How long a channel may stay un-joined before "Connecting…" becomes a lie. */
export const REALTIME_JOIN_TIMEOUT_MS = 10_000;

/**
 * Map a Supabase channel subscribe-callback status to the UI connection state.
 * `CLOSED` counts as failed: teardown-driven closes never reach the UI (the
 * effect cleanup cancels the callback first), so a CLOSED that does arrive
 * means the channel died underneath us.
 */
export function connectionFromChannelStatus(
  status: string,
): RealtimeConnectionState {
  switch (status) {
    case "SUBSCRIBED":
      return "live";
    case "CHANNEL_ERROR":
    case "TIMED_OUT":
    case "CLOSED":
      return "failed";
    default:
      return "connecting";
  }
}

/**
 * What the join-timeout watchdog does when it fires: only a still-connecting
 * channel degrades to failed — a channel that joined (or already failed for a
 * concrete reason) is left alone.
 */
export function connectionAfterJoinTimeout(
  current: RealtimeConnectionState,
): RealtimeConnectionState {
  return current === "connecting" ? "failed" : current;
}
