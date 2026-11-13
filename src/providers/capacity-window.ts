/**
 * Provider-scoped capacity window (2026-10-12).
 *
 * When the official backend sheds by weight, the shedding is a property of the PROVIDER at
 * that moment, not of any one request. Measured 2026-10-12 16:00-17:00: eight conversations
 * burned the FULL capacity ladder (5 sends, 100-409s each) inside the same hour, while lighter
 * conversations on the same account succeeded throughout; all twenty-one armed conversations
 * carried an active routing re-roll the whole time and it changed nothing. Every one of those
 * requests paid for five refusals to learn what the first one already said, and a request
 * arriving one minute later paid the same price again.
 *
 * This module is the shared memory they were missing. It is deliberately NOT a park: a
 * window-active request still sends and still keeps one short rung, so the first moment the
 * backend recovers is picked up by the very next request. What it stops paying for is the
 * other four rungs while the window is provably open.
 *
 * Judgement is a rolling count: three ladder-exhausted capacity failures inside four minutes.
 * No success clears it -- light requests succeed INSIDE an active window (that is the whole
 * shape of a weight-shaped shed), so a success-triggered clear would flap the window off
 * exactly while heavy turns are still dying. The window simply ages out; four minutes after
 * the last failure the full ladder is back.
 */

/**
 * Capacity failures inside this window that keep the window active.
 *
 * Widened from four minutes on 2026-10-13: the shelf that motivated this module fails in
 * CLUSTERS spread over several minutes, not inside one four-minute block. Measured that
 * morning, 10:30:35 / 10:30:37 / 10:36:16 / 10:39:04 -- every gap under seven minutes, and
 * the old window expired between each pair, so it never activated and the 10:36/10:39 turns
 * still paid the full ladder (107s and 99s) to learn what the failures a few minutes earlier
 * had already said.
 */
const CAPACITY_WINDOW_MS = 8 * 60_000;
/**
 * Ladder-exhausted failures needed to declare the window active.
 *
 * Two, down from three: the first refusal is unavoidable information, but a second
 * ladder-exhausted failure inside the window is already the pattern, and every further
 * request paying the full ladder while the provider is provably shedding is the cost this
 * module exists to remove. The recovery promise does not change -- a window-active request
 * still sends and still keeps one short rung, so the first request after recovery succeeds
 * and the window ages out behind the last failure.
 */
const CAPACITY_WINDOW_MIN_SHEDS = 2;

const sheds = new Map<string, number[]>();
/** Last observed window state per provider, so the mode transition logs once, not per request. */
const windowLoggedActive = new Map<string, boolean>();

/**
 * One request finished with its capacity ladder exhausted on this provider.
 *
 * Called from the terminal failure seam next to the thread-level overload verdict, so it sees
 * every transport and every route. Counting here (failures only) is what keeps the window
 * honest: an absorbed shed that eventually succeeded is evidence the window had room, and
 * never reaches this call.
 */
export function noteProviderCapacityShed(provider: string | undefined, now = Date.now()): void {
  const key = provider?.trim();
  if (!key) return;
  const history = (sheds.get(key) ?? []).filter(at => now - at < CAPACITY_WINDOW_MS);
  history.push(now);
  sheds.delete(key);
  sheds.set(key, history);
  noteWindowTransition(key, history.length >= CAPACITY_WINDOW_MIN_SHEDS, now);
  while (sheds.size > 256) {
    const oldest = sheds.keys().next().value;
    if (oldest === undefined) break;
    sheds.delete(oldest);
    windowLoggedActive.delete(oldest);
  }
}

/** True while this provider's recent failures say the capacity window is open. */
export function capacityWindowActive(provider: string | undefined, now = Date.now()): boolean {
  const key = provider?.trim();
  if (!key) return false;
  const history = sheds.get(key);
  if (!history) return false;
  const live = history.filter(at => now - at < CAPACITY_WINDOW_MS);
  const active = live.length >= CAPACITY_WINDOW_MIN_SHEDS;
  // Transition first, prune second: the closed-transition log needs the previous state,
  // which the pruning below discards.
  noteWindowTransition(key, active, now);
  if (live.length === 0) {
    sheds.delete(key);
    windowLoggedActive.delete(key);
  } else if (live.length !== history.length) {
    sheds.set(key, live);
  }
  return active;
}

function noteWindowTransition(key: string, active: boolean, now: number): void {
  const previous = windowLoggedActive.get(key);
  if (previous === active) return;
  windowLoggedActive.set(key, active);
  if (active) {
    const history = sheds.get(key) ?? [];
    console.warn(
      "[opencodex] " + key + ": capacity window active ("
      + history.length + " ladder-exhausted failures in "
      + Math.round(CAPACITY_WINDOW_MS / 60_000) + "min) - the capacity ladder is trimmed to one "
      + "short rung per request until the window ages out",
    );
  } else if (previous === true) {
    console.warn(
      "[opencodex] " + key + ": capacity window closed after "
      + Math.round(CAPACITY_WINDOW_MS / 60_000) + "min without a ladder-exhausted failure - full ladder restored",
    );
  }
}

/** Test seam. */
export function clearCapacityWindowsForTests(): void {
  sheds.clear();
  windowLoggedActive.clear();
}
