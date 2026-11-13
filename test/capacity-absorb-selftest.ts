/**
 * Self-test for the capacity absorb ladder in lib/upstream-retry.ts (2026-09-23).
 *
 * The canonical backend sheds a heavy turn with a 502/503/504 that can arrive in 1-36 seconds,
 * and one extra send is not enough to ride out a shed window. This checks the paced ladder the
 * official lane opts into: it must spend exactly the extra sends it was given, wait the delays it
 * was handed, and leave the ordinary (non-capacity) path untouched.
 *
 * Run: bun ~/.opencodex/tools/capacity-absorb-selftest.ts
 */
const PKG = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");
const { fetchWithTransientRetry } = await import(PKG + "/lib/upstream-retry.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? " - " + detail : ""));
  if (!ok) failures += 1;
}

const shed = () => new Response(JSON.stringify({ error: { message: "Our servers are currently overloaded. Please try again later.", type: "server_error" } }), { status: 503, headers: { "content-type": "application/json" } });
const ok = () => new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } });

async function run(optIn: boolean, shedCount: number, delays: number[]) {
  let calls = 0;
  const at: number[] = [];
  const startedAt = Date.now();
  const doFetch = async () => {
    calls += 1;
    at.push(Date.now() - startedAt);
    return calls <= shedCount ? shed() : ok();
  };
  const response = await fetchWithTransientRetry(doFetch as never, {
    attempts: 1,
    slowAttemptMs: 15_000,
    ...(optIn ? { retryCapacityDeferralsMs: delays } : {}),
  });
  return { status: response.status, calls, at };
}

/**
 * 2026-10-09: a heavy turn under sustained load is refused only after 25-45s of queueing, and the
 * same weight fails every rung. The second SLOW refusal must skip the remaining rungs instead of
 * pacing through them; the first refusal keeps its chance regardless of speed.
 */
async function runShedShape(shedMs: number[], delays: number[]) {
  let calls = 0;
  const doFetch = async () => {
    const wait = shedMs[Math.min(calls, shedMs.length - 1)] ?? 0;
    calls += 1;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    return shed();
  };
  const response = await fetchWithTransientRetry(doFetch as never, {
    attempts: 1,
    slowAttemptMs: 15_000,
    retryCapacityDeferralsMs: delays,
    slowShedAttemptMs: 60,
  });
  return { status: response.status, calls };
}

// Baseline: no opt-in, the send budget alone governs.
const baseline = await run(false, 3, []);
check("baseline: a shed response is returned after one send", baseline.status === 503 && baseline.calls === 1, "status=" + baseline.status + " sends=" + baseline.calls);

// Opt-in: two sheds absorbed with the caller's pacing, third send succeeds.
const absorbed = await run(true, 2, [80, 160]);
check("absorb: the turn succeeds", absorbed.status === 200, "status=" + absorbed.status);
check("absorb: one send per attempt", absorbed.calls === 3, "sends=" + absorbed.calls);
const gaps = absorbed.at.slice(1).map((t, i) => t - absorbed.at[i]!);
check("absorb: waits the delay it was given (80ms)", gaps[0]! >= 70 && gaps[0]! < 400, "gap=" + gaps[0]);
check("absorb: waits the second delay (160ms)", gaps[1]! >= 150 && gaps[1]! < 500, "gap=" + gaps[1]);

// Exhausted ladder: three sheds against a two-rung ladder keeps the upstream answer.
const exhausted = await run(true, 3, [30, 60]);
check("exhausted: ladder is bounded by its own length", exhausted.calls === 3, "sends=" + exhausted.calls);
check("exhausted: the last upstream answer is returned", exhausted.status === 503, "status=" + exhausted.status);

// An empty ladder must behave exactly like the baseline.
const empty = await run(true, 3, []);
check("empty ladder: no extra sends", empty.calls === 1 && empty.status === 503, "sends=" + empty.calls);

// Weight-shaped shed: first (fast) refusal walks the first rung, the second refusal arrives slowly
// and must hand the answer back instead of pacing through the remaining rungs.
const slowShed = await runShedShape([5, 90], [30, 60, 90, 120]);
check("slow shed: first refusal keeps its chance, second slow one stops the ladder", slowShed.calls === 2 && slowShed.status === 503, "sends=" + slowShed.calls + " status=" + slowShed.status);

// Fast refusals keep the full ladder: the threshold is never reached, all rungs are spent.
const fastShed = await runShedShape([0, 0, 0, 0], [30, 60, 90, 120]);
check("fast shed: the whole ladder still runs (first send + one per rung)", fastShed.calls === 5 && fastShed.status === 503, "sends=" + fastShed.calls + " status=" + fastShed.status);

console.log(failures === 0 ? "ALL CAPACITY ABSORB CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
