import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OcxProviderConfig } from "../types";
import type { ProviderQuota, ProviderQuotaReport } from "./quota";
import { providerUsesKeyAuthOverride, resolveProviderApiKey } from "./key-store";
import { getProviderRegistryEntry } from "./registry";
import { PROVIDER_QUOTA_MAX_AGE_MS } from "./quota-types";
import { getConfigDir } from "../config/paths";

export interface ProviderQuotaRoutingEvidence {
  quota: ProviderQuota;
  binding: string;
}

type CachedQuota = {
  quota: ProviderQuota;
  routing?: ProviderQuotaRoutingEvidence | { quota: ProviderQuota; testOnly: true };
};

const quotaCache = new Map<string, CachedQuota>();

/** Private cache identity; neither key material nor this digest enters management reports. */
export function providerQuotaRoutingBinding(
  name: string,
  provider: OcxProviderConfig,
  credential = resolveProviderApiKey(provider.apiKey)?.trim(),
): string | null {
  if ((provider.authMode ?? "key") !== "key" || !credential) return null;
  // Registry-owned OAuth/forward rows normalize saved authMode before dispatch.
  // A key probe must not constrain that later account selection.
  const entry = getProviderRegistryEntry(name);
  if (entry && (entry.authKind === "oauth" || entry.authKind === "forward")
    && !providerUsesKeyAuthOverride(entry, provider, credential)) return null;
  // Static auth headers can replace or combine with the probed API-key header.
  // Its semantics belong to the adapter, so it is not provider-wide quota evidence.
  if (Object.keys(provider.headers ?? {}).some(header =>
    ["authorization", "x-api-key", "x-goog-api-key"].includes(header.toLowerCase()))) return null;
  return createHash("sha256").update(JSON.stringify([
    name, provider.adapter, provider.baseUrl, credential,
  ])).digest("hex");
}

export function clearCachedProviderQuotas(): void {
  quotaCache.clear();
}

export function replaceCachedProviderQuotas(
  reports: ProviderQuotaReport[],
  routingEvidence?: WeakMap<ProviderQuotaReport, ProviderQuotaRoutingEvidence>,
): void {
  quotaCache.clear();
  for (const report of reports) {
    quotaCache.set(report.provider, { quota: report.quota, routing: routingEvidence?.get(report) });
  }
}

export function getCachedProviderQuota(
  provider: string,
  now: number,
  maxAgeMs = PROVIDER_QUOTA_MAX_AGE_MS,
): ProviderQuota | null {
  const quota = quotaCache.get(provider)?.quota;
  if (!quota) return null;
  if (now - quota.updatedAt > maxAgeMs) return null;
  return quota;
}

/** Only inference-wide evidence for this sole credential may rank or veto a whole provider. */
export function getCachedProviderRoutingQuota(
  name: string,
  provider: OcxProviderConfig | undefined,
  now: number,
  maxAgeMs = PROVIDER_QUOTA_MAX_AGE_MS,
): ProviderQuota | null {
  if (!provider || provider.disabled === true || (provider.authMode ?? "key") !== "key") return null;
  // An active-key report cannot speak for the other keys the dispatcher may select.
  if ((provider.apiKeyPool?.length ?? 0) > 1) return null;
  const routing = quotaCache.get(name)?.routing;
  if (routing && Number.isFinite(routing.quota.updatedAt) && routing.quota.updatedAt >= 0
    && routing.quota.updatedAt <= now && now - routing.quota.updatedAt < maxAgeMs) {
    const binding = providerQuotaRoutingBinding(name, provider);
    if (binding && ("testOnly" in routing || routing.binding === binding)) return routing.quota;
  }
  // Relay panels publish their own plan state (`ocxquota --export`). It is account-scoped, not
  // credential-scoped, so it needs no binding -- and it is the only quota evidence these rows
  // have at all, because no probe speaks for a third-party relay.
  return panelProviderQuota(name, now, maxAgeMs);
}

/** How long the exported panel file is trusted after it was read from disk. */
const PANEL_QUOTA_FILE_TTL_MS = 15_000;

interface PanelQuotaEntry {
  quota: ProviderQuota;
  /** The site's own verdict moved this provider behind the healthy ones (never out of the ladder). */
  degraded: boolean;
  /** Mostly-broken per the site: skipped while alternatives exist, but never to the point of 503. */
  hopeless: boolean;
}

let panelQuotaFile: { readAt: number; generatedAt: number; providers: Map<string, PanelQuotaEntry> } | null = null;

/**
 * One panel-published quota, in the millisecond units every quota comparison here uses.
 *
 * The exporter writes epoch SECONDS (that is what the panels report). A reset that is days away
 * would otherwise read as long past and the window would never look exhausted, so the unit is
 * fixed up once, here, at the boundary that consumes it.
 */
function panelEntry(name: string, now: number, maxAgeMs: number): PanelQuotaEntry | null {
  if (!panelQuotaFile || now - panelQuotaFile.readAt >= PANEL_QUOTA_FILE_TTL_MS) {
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(join(getConfigDir(), "provider-quota.json"), "utf8"));
    } catch {
      panelQuotaFile = null;
      return null;
    }
    const generatedAt = (payload as { generatedAt?: unknown } | null)?.generatedAt;
    const providers = (payload as { providers?: unknown } | null)?.providers;
    if (typeof generatedAt !== "number" || !providers || typeof providers !== "object") {
      panelQuotaFile = null;
      return null;
    }
    const map = new Map<string, PanelQuotaEntry>();
    for (const [provider, entry] of Object.entries(providers as Record<string, unknown>)) {
      const source = ((entry as { opencodex?: unknown } | null)?.opencodex ?? {}) as Record<string, unknown>;
      const quota: Record<string, unknown> = { updatedAt: generatedAt };
      for (const key of ["fiveHourPercent", "fiveHourResetAt", "weeklyPercent", "weeklyResetAt",
        "monthlyPercent", "monthlyResetAt"] as const) {
        const value = source[key];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        quota[key] = key.endsWith("ResetAt") && value < 1e12 ? value * 1000 : value;
      }
      if (Array.isArray(source.customWindows)) {
        // Availability readouts ride in this array only because it is the one shape the panel
        // renders into a row. They are NOT quota: a site's own up/down rating must never satisfy
        // the exhaustion predicate, which gates routing. That verdict travels separately as
        // `official.degraded` / `official.hopeless` (a soft, self-clearing demotion).
        quota.customWindows = (source.customWindows as Array<Record<string, unknown>>)
          .filter(window => window && window.kind !== "availability")
          .map(window => ({
          label: String(window.label ?? "window"),
          percent: typeof window.percent === "number" ? window.percent : 0,
          ...(typeof window.resetAt === "number" && Number.isFinite(window.resetAt)
            ? { resetAt: window.resetAt < 1e12 ? window.resetAt * 1000 : window.resetAt }
            : {}),
          }));
      }
      const official = ((entry as { official?: Record<string, unknown> } | null)?.official) ?? {};
      const degraded = official.degraded === true;
      const hopeless = official.hopeless === true;
      map.set(provider, { quota: quota as unknown as ProviderQuota, degraded, hopeless });
    }
    panelQuotaFile = { readAt: now, generatedAt, providers: map };
  }
  if (now - panelQuotaFile.generatedAt >= maxAgeMs) return null;
  return panelQuotaFile.providers.get(name) ?? null;
}

function panelProviderQuota(name: string, now: number, maxAgeMs: number): ProviderQuota | null {
  return panelEntry(name, now, maxAgeMs)?.quota ?? null;
}

/**
 * Official-availability tier for combo selection: `true` means the site itself reports this
 * provider as unhealthy, so an ordered ladder should try it after the healthy ones.
 */
export function panelProviderDegraded(name: string, now = Date.now()): boolean {
  return panelEntry(name, now, PROVIDER_QUOTA_MAX_AGE_MS)?.degraded === true;
}

/** The site reports this channel as mostly broken; a soft skip, so it is used as a last resort. */
export function panelProviderHopeless(name: string, now = Date.now()): boolean {
  return panelEntry(name, now, PROVIDER_QUOTA_MAX_AGE_MS)?.hopeless === true;
}

export function setCachedProviderQuotaForTests(
  provider: string,
  quota: ProviderQuota,
): void {
  // Unit tests deliberately assert the supplied quota's scope. Production publication
  // requires the producer's private, credential-bound evidence map above.
  quotaCache.set(provider, { quota, routing: { quota, testOnly: true } });
}
