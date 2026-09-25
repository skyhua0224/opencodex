#!/usr/bin/env python3
"""ocx-tiers - did the origin serve what was asked for, and where did the time go?

Four questions, one command:

  * service tier - configured (fast/priority/auto) vs what the response reported;
  * model        - the model the origin said it answered as, against the one requested;
  * degeneration - streams this proxy cut because the channel started repeating itself;
  * link/latency - whether this lane ever sees the edge's load-balancer affinity cookies,
                   and how a slow turn's time splits (our queue / origin headers / first
                   content / tail).
  * ws reuse     - the WebSocket lanes side by side: one socket per turn, a resend inside one
                   turn, and a socket reused for a later turn of the same conversation -- with
                   the failure rate and first-frame latency of each.

Sources: ~/.opencodex/usage.jsonl, model-attestation.jsonl, cookie-link.jsonl, latency.jsonl,
ws-reuse.jsonl.
"""
import argparse, collections, json, os, statistics, time
from datetime import datetime

HOME = os.path.expanduser('~/.opencodex')
USAGE = os.path.join(HOME, 'usage.jsonl')
FINDINGS = os.path.join(HOME, 'model-attestation.jsonl')
LINKS = os.path.join(HOME, 'cookie-link.jsonl')
LATENCY = os.path.join(HOME, 'latency.jsonl')
WS_REUSE = os.path.join(HOME, 'ws-reuse.jsonl')
QUALITY = os.path.join(HOME, 'intelligence-probe.jsonl')
HOLDS = os.path.join(HOME, 'quality-holds.json')
FINGERPRINT = os.path.join(HOME, 'fingerprint-drift.jsonl')
RANK = {'flex': 0, 'auto': 1, 'default': 1, 'priority': 2, 'scale': 2, 'fast': 2}


def rows(hours):
    cutoff = (time.time() - hours * 3600) * 1000
    try:
        fh = open(USAGE, errors='replace')
    except OSError:
        return []
    out = []
    with fh:
        seek = max(0, os.path.getsize(USAGE) - 96 * 1024 * 1024)
        fh.seek(seek)
        if seek: fh.readline()
        for line in fh:
            if 'conversationId' not in line: continue
            try: row = json.loads(line)
            except Exception: continue
            if (row.get('timestamp') or 0) < cutoff: continue
            out.append(row)
    return out


def ledger(path, hours):
    cutoff = (time.time() - hours * 3600) * 1000
    out = []
    try:
        fh = open(path, errors='replace')
    except OSError:
        return out
    with fh:
        for line in fh:
            try: entry = json.loads(line)
            except Exception: continue
            if (entry.get('at') or 0) >= cutoff: out.append(entry)
    return out


def tier_rows(rows_):
    per = collections.Counter()
    downgraded = []
    for row in rows_:
        configured = row.get('configuredServiceTier')
        served = row.get('responseServiceTier')
        if row.get('status') != 200: continue
        per[(row.get('provider'), configured or '-', served or '-')] += 1
        c, s = RANK.get((configured or '').lower()), RANK.get((served or '').lower())
        if c is not None and s is not None and s < c and c > RANK['default']:
            downgraded.append(row)
    return per, downgraded


def degenerate(rows_):
    return [r for r in rows_ if 'degenerate output' in str(r.get('upstreamError') or '')
            or 'degenerate_output' in str(r.get('errorCode') or '')]


def link_summary(hours):
    entries = ledger(LINKS, hours)
    with_routing = [e for e in entries if e.get('routingNames')]
    client_sent = [e for e in entries if e.get('clientSentCookie')]
    pairs = collections.defaultdict(set)
    for entry in with_routing:
        if entry.get('pairTag'):
            pairs[(entry.get('lane') or '?')[:8]].add(entry['pairTag'])
    return entries, with_routing, client_sent, pairs


def latency_summary(hours):
    entries = ledger(LATENCY, hours)
    def med(key):
        vals = [e.get(key) for e in entries if isinstance(e.get(key), (int, float))]
        return int(statistics.median(vals)) if vals else None
    return entries, med('queueMs'), med('headersMs'), med('firstContentMs'), med('totalMs')


def ws_reuse_summary(hours):
    entries = ledger(WS_REUSE, hours)
    events = collections.Counter(e.get('event') for e in entries)
    reused = [e for e in entries if e.get('event') == 'cross-turn-reuse']
    failed = [e for e in entries if e.get('event') == 'cross-turn-fail']

    def med(key, rows=None):
        vals = [e.get(key) for e in (reused if rows is None else rows) if isinstance(e.get(key), (int, float))]
        return int(statistics.median(vals)) if vals else None
    return entries, events, reused, failed, med('idleMs'), med('ageMs')


def ws_lane_rows(rows_):
    """Split the WebSocket lane three ways: fresh, resend inside one turn, cross-turn reuse."""
    lanes = collections.defaultdict(lambda: {'n': 0, 'fail': 0, 'firstFrame': [], 'firstOutput': [], 'elapsed': []})
    for row in rows_:
        for attempt in row.get('attempts') or []:
            stage = attempt.get('codexWsStage')
            if not isinstance(stage, dict):
                continue
            lane = 'cross-turn' if stage.get('crossTurn') is True else (
                'resend (same turn)' if stage.get('reused') is True else 'fresh')
            bucket = lanes[lane]
            bucket['n'] += 1
            if attempt.get('status') != 200:
                bucket['fail'] += 1
            for field, key in (('firstFrameMs', 'firstFrame'), ('firstOutputMs', 'firstOutput'),
                               ('elapsedMs', 'elapsed')):
                value = stage.get(field) if field != 'firstOutputMs' else attempt.get(field)
                if isinstance(value, (int, float)):
                    bucket[key].append(value)
    return lanes


def ws_lane_medians(bucket):
    def med(key):
        return int(statistics.median(bucket[key])) if bucket[key] else None
    return med('firstFrame'), med('firstOutput'), med('elapsed')


def attempt_metric(row, field, ws_field):
    """First non-null value of one latency metric across a row's attempts (WS stage included)."""
    for attempt in row.get('attempts') or []:
        value = attempt.get(field)
        if isinstance(value, (int, float)):
            return value
        stage = attempt.get('codexWsStage')
        if isinstance(stage, dict) and isinstance(stage.get(ws_field), (int, float)):
            return stage[ws_field]
    return None


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))
    return ordered[index]


def health_rows(rows_):
    """Per provider: error rate and p90 first output, blended into one 0-100 score.

    Bands follow the two things an operator can act on: an error rate above 10% is a dead lane and
    below 1% a healthy one; a p90 first output above 15s is the "stuck for half a minute" lane this
    deployment actually has, below 1.5s the fast one. Both halves are worth half the score, the
    same split a dashboard health score uses.
    """
    lanes = {}
    for row in rows_:
        provider = str(row.get('provider') or '?')
        bucket = lanes.setdefault(provider, {'attempts': 0, 'failed': 0, 'first': []})
        for attempt in row.get('attempts') or []:
            bucket['attempts'] += 1
            if attempt.get('status') != 200:
                bucket['failed'] += 1
        value = attempt_metric(row, 'firstOutputMs', 'firstFrameMs')
        if isinstance(value, (int, float)):
            bucket['first'].append(value)
    out = {}
    for provider, bucket in lanes.items():
        error_pct = 100.0 * bucket['failed'] / bucket['attempts'] if bucket['attempts'] else 0.0
        p90 = percentile(bucket['first'], 0.9)
        error_score = 100.0 if error_pct <= 1 else (0.0 if error_pct >= 10 else (10 - error_pct) / 9 * 100)
        ttft_score = 100.0 if p90 is None else (0.0 if p90 >= 15000 else (15000 - p90) / 13500 * 100)
        out[provider] = {'attempts': bucket['attempts'], 'failed': bucket['failed'],
                         'errorPct': round(error_pct, 1), 'p90FirstMs': p90,
                         'score': int(0.5 * error_score + 0.5 * ttft_score)}
    return out


def quality_summary(hours):
    entries = ledger(QUALITY, hours)
    rounds = [e for e in entries if e.get('kind') == 'round-summary']
    holds = {}
    try:
        with open(HOLDS) as handle:
            payload = json.load(handle)
        holds = payload.get('holds') or {}
    except Exception:
        holds = {}
    by_provider = {}
    for entry in rounds:
        provider = entry.get('provider')
        if provider:
            by_provider[provider] = entry
    return entries, rounds, by_provider, holds


def main():
    ap = argparse.ArgumentParser(prog='ocx-tiers', description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--hours', type=float, default=6.0)
    ap.add_argument('--findings', action='store_true', help='only list the attestation ledger')
    ap.add_argument('--links', action='store_true', help='only summarise the link ledger')
    ap.add_argument('--latency', action='store_true', help='only summarise the latency ledger')
    ap.add_argument('--wsreuse', action='store_true', help='only report the WebSocket reuse lanes')
    ap.add_argument('--health', action='store_true', help='only report the per-provider health score')
    ap.add_argument('--quality', action='store_true', help='only report intelligence-probe rounds and holds')
    ap.add_argument('--fingerprints', action='store_true', help='only list client fingerprint drift')
    args = ap.parse_args()
    found = ledger(FINDINGS, args.hours)

    if args.health:
        rows_ = rows(args.hours)
        lanes = health_rows(rows_)
        print('health: %d providers in the last %gh' % (len(lanes), args.hours))
        print('%-24s %9s %7s %8s %12s %7s' % ('provider', 'attempts', 'failed', 'err%', 'p90 first', 'score'))
        for provider, lane in sorted(lanes.items(), key=lambda item: item[1]['score']):
            print('%-24s %9d %7d %7.1f%% %12s %7d' % (provider, lane['attempts'], lane['failed'],
                  lane['errorPct'], (str(lane['p90FirstMs']) + 'ms') if lane['p90FirstMs'] is not None else '-',
                  lane['score']))
        return 0

    if args.quality:
        entries, rounds, by_provider, holds = quality_summary(args.hours)
        now = time.time() * 1000
        print('quality: %d probe rows, %d round summaries, %d active hold(s)' % (len(entries), len(rounds),
              sum(1 for value in holds.values() if (value.get('until') or 0) > now)))
        for provider in sorted(set(list(by_provider) + list(holds))):
            summary = by_provider.get(provider) or {}
            hold = holds.get(provider) or {}
            active = (hold.get('until') or 0) > now
            print('  %-22s last round: asked=%s correct=%s wrong=%s inconclusive=%s action=%s%s' % (
                provider, summary.get('asked', '-'), summary.get('correct', '-'),
                summary.get('incorrect', '-'), summary.get('inconclusive', '-'),
                summary.get('action', 'never'),
                ('   HELD %dmin: %s' % (round(((hold.get('until') or 0) - now) / 60000), (hold.get('reason') or '')[:70])) if active else ''))
        return 0

    if args.fingerprints:
        entries = ledger(FINGERPRINT, args.hours)
        print('fingerprints: %d drift rows in the last %gh' % (len(entries), args.hours))
        for entry in entries[-15:]:
            when = datetime.fromtimestamp((entry.get('at') or 0) / 1000).strftime('%m-%d %H:%M')
            print('  %s  %-16s %s' % (when, entry.get('provider') or '-', ','.join(entry.get('changes') or [])))
        if not entries:
            print('  no drift rows in window')
        return 0

    if args.wsreuse:
        entries, events, reused, failed, idle, age = ws_reuse_summary(args.hours)
        print('ws reuse: %d events   cross-turn reuses: %d   failed: %d   breaker opens: %d'
              % (len(entries), len(reused), len(failed), events.get('cross-turn-breaker-open', 0)))
        print('          reuse idle p50=%s   socket age p50=%s'
              % ('%dms' % idle if idle is not None else '-', '%dms' % age if age is not None else '-'))
        lanes = ws_lane_rows(rows(args.hours))
        print()
        print('%-20s %9s %7s %8s %14s %16s' % ('lane', 'attempts', 'failed', 'fail%', 'first frame p50', 'first output p50'))
        for lane in ('fresh', 'resend (same turn)', 'cross-turn'):
            bucket = lanes.get(lane)
            if not bucket:
                continue
            first_frame, first_output, _ = ws_lane_medians(bucket)
            print('%-20s %9d %7d %7.1f%% %14s %16s' % (
                lane, bucket['n'], bucket['fail'], 100.0 * bucket['fail'] / bucket['n'],
                str(first_frame) + 'ms' if first_frame is not None else '-',
                str(first_output) + 'ms' if first_output is not None else '-'))
        for entry in failed[-6:]:
            when = datetime.fromtimestamp((entry.get('at') or 0) / 1000).strftime('%m-%d %H:%M')
            print('  %s  %-22s firstFrame=%s elapsed=%s close=%s' % (
                when, (entry.get('reason') or '?')[:22], entry.get('firstFrameMs'),
                entry.get('elapsedMs'), entry.get('closeCode')))
        if not entries and not lanes:
            print('  no reuse rows in window')
        return 0

    if args.links:
        entries, with_routing, client_sent, pairs = link_summary(args.hours)
        print('link: %d requests, %d with an affinity pair, %d where the client sent one'
              % (len(entries), len(with_routing), len(client_sent)))
        names = collections.Counter(n for e in with_routing for n in (e.get('routingNames') or []))
        if names: print('  names:', dict(names))
        for lane, tags in sorted(pairs.items()):
            print('  lane %s: %d distinct pair(s)%s' % (lane, len(tags),
                  '  <== the node changed inside this lane' if len(tags) > 1 else '  (stable)'))
        if not entries: print('  no link rows in window')
        return 0

    if args.latency:
        entries, q, h, f, t = latency_summary(args.hours)
        print('latency: %d slow turns   median queue=%s headers=%s first=%s total=%s' % (len(entries), q, h, f, t))
        for entry in entries[-10:]:
            when = datetime.fromtimestamp((entry.get('at') or 0) / 1000).strftime('%m-%d %H:%M')
            print('  %s  %-8s %-16s queue=%s headers=%s first=%s total=%s (%s)' % (
                when, (entry.get('lane') or '')[:8], entry.get('model') or '-',
                entry.get('queueMs'), entry.get('headersMs'), entry.get('firstContentMs'),
                entry.get('totalMs'), entry.get('outcome')))
        if not entries: print('  no latency rows in window')
        return 0

    if args.findings:
        for entry in found[-40:]:
            when = datetime.fromtimestamp((entry.get('at') or 0) / 1000).strftime('%m-%d %H:%M')
            print('%s  %-16s %s  %s' % (when, entry.get('kind', '?'), entry.get('provider') or '-',
                                        (entry.get('detail') or '')[:110]))
        if not found: print('no findings in window')
        return 0

    rows_ = rows(args.hours)
    print('window: last %gh   requests: %d' % (args.hours, len(rows_)))
    per, downgraded = tier_rows(rows_)
    print()
    print('service tier  provider        configured -> served   requests')
    for (provider, configured, served), count in sorted(per.items(), key=lambda kv: -kv[1])[:12]:
        c, s = RANK.get(configured.lower()), RANK.get(served.lower())
        mark = '  <== downgrade' if (c is not None and s is not None and s < c and c > RANK['default']) else ''
        print('              %-15s %10s -> %-10s %6d%s' % (str(provider), configured, served, count, mark))
    mismatch = [f for f in found if f.get('kind') == 'model-mismatch']
    buffers = [f for f in found if f.get('kind') == 'safety-buffering']
    tier_hits = [f for f in found if f.get('kind') == 'tier-downgrade']
    cuts = degenerate(rows_)
    print()
    print('attestation  model mismatches: %d   tier downgrades: %d   safety buffers: %d'
          % (len(mismatch), len(tier_hits), len(buffers)))
    print('degenerate   streams cut: %d' % len(cuts))
    for entry in (mismatch + tier_hits + buffers)[-6:]:
        when = datetime.datetime.fromtimestamp((entry.get('at') or 0) / 1000).strftime('%m-%d %H:%M') if False else datetime.fromtimestamp((entry.get('at') or 0) / 1000).strftime('%m-%d %H:%M')
        print('    %s  %-16s %s' % (when, entry.get('kind'), (entry.get('detail') or '')[:100]))
    for row in cuts[-3:]:
        when = datetime.fromtimestamp((row.get('timestamp') or 0) / 1000).strftime('%m-%d %H:%M')
        print('    %s  cut              %s %s' % (when, (row.get('conversationId') or '')[:8],
                                                   str(row.get('upstreamError'))[:90]))
    link_entries, link_routing, link_client, link_pairs = link_summary(args.hours)
    latch, latq, lath, latf, latt = latency_summary(args.hours)
    print()
    print('link         requests: %d   with affinity pair: %d   client sent one: %d'
          % (len(link_entries), len(link_routing), len(link_client)))
    unstable = [lane for lane, tags in link_pairs.items() if len(tags) > 1]
    if unstable:
        print('             lanes whose pair changed: %s' % ', '.join(sorted(unstable)))
    print('latency      slow turns: %d   median queue=%s headers=%s first=%s total=%s'
          % (len(latch), latq, lath, latf, latt))
    ws_entries, ws_events, ws_reused, ws_failed, ws_idle, ws_age = ws_reuse_summary(args.hours)
    ws_lanes = ws_lane_rows(rows_)
    lanes = health_rows(rows_)
    worst = sorted(lanes.items(), key=lambda item: item[1]['score'])[:3]
    print('health        %s' % ', '.join('%s=%d(%d attempts, p90 %sms)'
          % (provider, lane['score'], lane['attempts'], lane['p90FirstMs']) for provider, lane in worst))
    qentries, qrounds, qprovider, qholds = quality_summary(args.hours)
    now = time.time() * 1000
    active_holds = [name for name, value in qholds.items() if (value.get('until') or 0) > now]
    print('quality       probe rows: %d, rounds: %d, active holds: %s' % (len(qentries), len(qrounds),
          ', '.join(active_holds) if active_holds else 'none'))
    print('ws reuse     cross-turn: %d attempts, %d failed (events: %d reuse, %d ok, %d fail, %d breaker)'
          % (ws_lanes.get('cross-turn', {}).get('n', 0), ws_lanes.get('cross-turn', {}).get('fail', 0),
             ws_events.get('cross-turn-reuse', 0), ws_events.get('cross-turn-ok', 0),
             ws_events.get('cross-turn-fail', 0), ws_events.get('cross-turn-breaker-open', 0)))
    if not found and not cuts and not link_entries and not latch:
        print('    nothing to report yet: no findings, no cut streams, no slow turns recorded')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
