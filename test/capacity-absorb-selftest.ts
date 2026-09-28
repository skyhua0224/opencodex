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

console.log(failures === 0 ? "ALL CAPACITY ABSORB CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
