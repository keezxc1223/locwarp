// Who gets a WiFi tunnel attempt during launch auto-connect and during a
// manual WiFi scan, and how a scan's results are counted.
//
// Pure functions with no runtime imports, so the rules can be read and
// tested on their own. Originally written by chang-chih-yao.

/** 自動連線 (`auto`) or a WiFi 掃描 the user pressed (`scan`). */
export type ConnectMode = 'auto' | 'scan';

/** A saved address, already narrowed to this PC's LAN by `savedIpsForPrefix`. */
export interface SavedIpInput {
  ip: string;
  port: number;
  /** Missing on old entries and on the legacy single-IP fallback. */
  udid?: string;
  lastUsed: number;
}

/** One `/wifi/tunnel/discover` hit. */
export interface DiscoveredInput {
  ip: string;
  port: number;
  /** Every open port a subnet scan found; mDNS hits have none. */
  ports?: number[];
  /** How the backend found it; `tcp_scan` is the subnet-scan fallback. */
  method?: 'mdns' | 'tcp_scan';
}

export interface CandidateInput {
  mode: ConnectMode;
  savedIps: SavedIpInput[];
  discovered: DiscoveredInput[];
  /** Every connected device, USB and WiFi. */
  connectedUdids: string[];
  /** The phone-side LAN IP of every WiFi 通道 the backend holds. */
  tunnelIps: string[];
  pinnedUdids: string[];
}

/** Group-mode device cap, USB and WiFi together; the backend enforces the same. */
export { MAX_DEVICES } from './deviceSlots';
import { MAX_DEVICES } from './deviceSlots';

/**
 * Where a candidate came from. `subnet` is the TCP scan fallback: it only
 * sees an open port, so the host may not be an iPhone at all.
 */
export type CandidateSource = 'saved' | 'mdns' | 'subnet';

export interface WifiCandidate {
  ip: string;
  /** Ports to try in order, saved ones first; never empty. */
  ports: number[];
  /** Which pair record the backend should try first. */
  udid: string | undefined;
  sources: CandidateSource[];
}

/**
 * Whether discovery results are used at all, so the caller can skip the
 * mDNS / subnet scan when they aren't.
 *
 * Pins only govern connecting without a button press: 自動連線 with
 * pins sticks to the pinned phones' saved addresses, so a friend's phone on
 * the same WiFi isn't grabbed (issue #35).
 */
export function needsDiscovery(mode: ConnectMode, pinnedUdids: ReadonlyArray<string>): boolean {
  return mode === 'scan' || pinnedUdids.length === 0;
}

/**
 * Try order rank, lower first. A failed attempt holds its slot
 * (`fillFreeSlots`), so whoever is most likely to answer goes first:
 *
 * 0. saved and found again by this discovery;
 * 1. only mDNS: always an iPhone on this WiFi right now, e.g. one whose
 *    DHCP address changed;
 * 2. only saved: most often fails because the phone's WiFi is off;
 * 3. only the subnet scan: may not be an iPhone and hold its slot for the
 *    full 45 s start budget.
 */
function tryRank(sources: ReadonlyArray<CandidateSource>): number {
  if (sources.includes('saved')) {
    return sources.includes('mdns') || sources.includes('subnet') ? 0 : 2;
  }
  return sources.includes('mdns') ? 1 : 3;
}

/**
 * The addresses to start a WiFi 通道 on, best first. Not capped:
 * `fillFreeSlots` decides how many get tried.
 *
 * @param input everything known about the LAN and the devices right now.
 * @returns every candidate: saved and found again, then mDNS only, then
 *   saved only, then subnet scan only. Saved ones keep newest `lastUsed`
 *   first within their rank, discovered ones the discovery order.
 */
export function wifiCandidates(input: CandidateInput): WifiCandidate[] {
  const pinsOnly = !needsDiscovery(input.mode, input.pinnedUdids);
  const saved = pinsOnly
    ? input.savedIps.filter((e) => e.udid && input.pinnedUdids.includes(e.udid))
    : input.savedIps;
  const discovered = pinsOnly ? [] : input.discovered;

  const out: WifiCandidate[] = [];
  const add = (ip: string, ports: number[], source: CandidateSource, udid?: string) => {
    // Applies to every source, not just discovery: a saved address may have
    // no UDID for the connected-skip to catch, and re-requesting a tunnelled
    // phone on another port stalls for the full 45 s start budget.
    if (input.tunnelIps.includes(ip)) return;
    // One request per IP. Two requests for one phone (saved port != the
    // discovered one) race each other in the backend, and the loser burns
    // up to the 45 s budget before failing.
    const hit = out.find((c) => c.ip === ip);
    if (!hit) {
      out.push({ ip, ports: [...new Set(ports)], udid, sources: [source] });
      return;
    }
    for (const p of ports) if (!hit.ports.includes(p)) hit.ports.push(p);
    if (!hit.sources.includes(source)) hit.sources.push(source);
    if (!hit.udid) hit.udid = udid;
  };
  // One candidate per phone, the newest address: entries written
  // before the prefix tag existed can leave two addresses for one device.
  // The UDID is claimed before the skips below, so a skipped newest address
  // doesn't hand the phone to an older, likely dead one.
  const udidSeen = new Set<string>();
  for (const e of [...saved].sort((a, b) => b.lastUsed - a.lastUsed)) {
    if (e.udid) {
      if (udidSeen.has(e.udid)) continue;
      udidSeen.add(e.udid);
    }
    // Already connected over USB or WiFi: leave it alone, so a USB phone
    // isn't switched to WiFi and a WiFi phone's route isn't cut.
    if (e.udid && input.connectedUdids.includes(e.udid)) continue;
    add(e.ip, [e.port], 'saved', e.udid);
  }
  for (const d of discovered) {
    add(d.ip, [d.port, ...(d.ports || [])], d.method === 'mdns' ? 'mdns' : 'subnet');
  }
  // Stable sort: within a rank, the order built above stands.
  return out.sort((a, b) => tryRank(a.sources) - tryRank(b.sources));
}

/** What one candidate's start-and-connect request came back with. */
export type CandidateOutcome = 'connected' | 'already_connected' | 'failed';

/**
 * Tries the candidates best first, one slot per device the cap still
 * allows, the slots in parallel.
 *
 * A slot whose candidate answers `already_connected` moves on to the next
 * one. That answer comes from a phone that is connected already, typically
 * a USB phone also on this WiFi, whose mDNS hit has no UDID to skip it by,
 * and it shouldn't cost a phone still waiting its turn (Q12: group users
 * don't regress). Any other outcome ends the slot. A failure isn't followed
 * by the next candidate, because a subnet-scan host that isn't an iPhone
 * can hold its request for the full 45 s.
 *
 * @param candidates in the order to try, as `wifiCandidates` returns them.
 * @param connectedCount devices connected before this pass, USB and WiFi.
 * @param attempt starts one candidate; resolves with its outcome, never throws.
 * @returns every attempt's result, in completion order.
 */
export async function fillFreeSlots<C, R extends { outcome: CandidateOutcome }>(
  candidates: ReadonlyArray<C>,
  connectedCount: number,
  attempt: (candidate: C) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const results: R[] = [];
  const slot = async () => {
    while (next < candidates.length) {
      const r = await attempt(candidates[next++]);
      results.push(r);
      if (r.outcome !== 'already_connected') return;
    }
  };
  const slots = Math.max(0, MAX_DEVICES - connectedCount);
  await Promise.all(Array.from({ length: slots }, slot));
  return results;
}

/** A WiFi 掃描's result as the button reports it. */
export interface WifiScanTally {
  /** Newly connected phones. */
  connected: number;
  /** Phones known to be on this WiFi that still didn't connect. */
  failed: number;
}

/**
 * Counts a WiFi 掃描 for the button: new connections, and failures.
 *
 * @param results each candidate's sources and outcome.
 * @returns the counts; `already_connected` lands in neither.
 */
export function tallyWifiResults(
  results: ReadonlyArray<{ sources: ReadonlyArray<CandidateSource>; outcome: CandidateOutcome }>,
): WifiScanTally {
  let connected = 0;
  let failed = 0;
  for (const r of results) {
    if (r.outcome === 'connected') connected++;
    // Only an mDNS hit proves the phone is on this WiFi. A saved address
    // that doesn't answer most often means the phone's WiFi is off (the case
    // this button exists for), and a subnet-scan host may not be an iPhone.
    else if (r.outcome === 'failed' && r.sources.includes('mdns')) failed++;
  }
  return { connected, failed };
}
