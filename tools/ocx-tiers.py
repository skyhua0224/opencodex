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


def main():
    ap = argparse.ArgumentParser(prog='ocx-tiers', description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--hours', type=float, default=6.0)
    ap.add_argument('--findings', action='store_true', help='only list the attestation ledger')
    ap.add_argument('--links', action='store_true', help='only summarise the link ledger')
    ap.add_argument('--latency', action='store_true', help='only summarise the latency ledger')
    ap.add_argument('--wsreuse', action='store_true', help='only report the WebSocket reuse lanes')
    args = ap.parse_args()
    found = ledger(FINDINGS, args.hours)

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
    print('ws reuse     cross-turn: %d attempts, %d failed (events: %d reuse, %d ok, %d fail, %d breaker)'
          % (ws_lanes.get('cross-turn', {}).get('n', 0), ws_lanes.get('cross-turn', {}).get('fail', 0),
             ws_events.get('cross-turn-reuse', 0), ws_events.get('cross-turn-ok', 0),
             ws_events.get('cross-turn-fail', 0), ws_events.get('cross-turn-breaker-open', 0)))
    if not found and not cuts and not link_entries and not latch:
        print('    nothing to report yet: no findings, no cut streams, no slow turns recorded')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
