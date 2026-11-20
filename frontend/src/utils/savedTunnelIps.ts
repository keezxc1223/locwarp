// Shared store for remembered WiFi-tunnel addresses (localStorage key
// `locwarp.tunnel.savedips`). Read and written by useDevice (on every
// successful connect, and by the pinned-device reconnect loop), by App's
// launch auto-connect, and by the WiFi panel's "recent IPs" dropdown.
//
// Entries are keyed by (udid, prefix) where prefix is the first three
// octets of the address the phone was reached on. A phone that moves to a
// new DHCP address inside the same LAN replaces its old entry (so dead
// addresses don't pile up), while the same phone on a different WiFi gets
// a second entry instead of overwriting the first one (issue #48).

export type SavedTunnelIp = {
  ip: string;
  port: number;
  udid?: string;
  name?: string;
  // /24 prefix of `ip`. Older builds wrote entries without it; treat those
  // as "prefix unknown" and derive it from the IP when needed.
  prefix?: string;
  lastUsed: number;
};

const KEY = 'locwarp.tunnel.savedips';
// Room for a couple of phones across home / office / hotspot. The launch
// auto-connect filters by prefix first, so a longer list costs nothing in
// connect attempts.
export const MAX_SAVED_IPS = 10;

/** First three octets of an IPv4, or null if it isn't one. */
export const prefixOf = (ip: string): string | null => {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.slice(0, 3).join('.');
};

/** Prefix recorded on an entry, falling back to deriving it from the IP. */
export const entryPrefix = (entry: SavedTunnelIp): string | null =>
  entry.prefix || prefixOf(entry.ip);

export const readSavedIps = (): SavedTunnelIp[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e.ip === 'string' && e.ip.trim())
      .map((e) => ({
        ip: String(e.ip).trim(),
        port: Number(e.port) || 49152,
        udid: typeof e.udid === 'string' && e.udid ? e.udid : undefined,
        name: typeof e.name === 'string' && e.name ? e.name : undefined,
        prefix: typeof e.prefix === 'string' && e.prefix ? e.prefix : undefined,
        lastUsed: Number(e.lastUsed) || 0,
      }));
  } catch {
    return [];
  }
};

export const writeSavedIps = (list: SavedTunnelIp[]): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_SAVED_IPS)));
  } catch {
    /* storage disabled */
  }
};

/**
 * Record a successful connect. Drops any entry with the same (ip, port) and
 * any entry for the same device on the same LAN, then puts the new one at
 * the front (most-recent-first ordering the dropdown relies on).
 */
export const upsertSavedIp = (entry: {
  ip: string;
  port: number;
  udid?: string;
  name?: string;
}): SavedTunnelIp[] => {
  const prefix = prefixOf(entry.ip);
  const fresh: SavedTunnelIp = {
    ip: entry.ip,
    port: entry.port,
    udid: entry.udid,
    name: entry.name,
    prefix: prefix || undefined,
    lastUsed: Date.now(),
  };
  const kept = readSavedIps().filter((e) => {
    if (e.ip === entry.ip && e.port === entry.port) return false;
    // Same phone, same LAN: its address changed, so the old one is dead.
    // Entries saved on another LAN are kept, which is the whole point of
    // the prefix tag.
    if (entry.udid && e.udid === entry.udid && prefix && entryPrefix(e) === prefix) return false;
    return true;
  });
  const next = [fresh, ...kept].slice(0, MAX_SAVED_IPS);
  writeSavedIps(next);
  return next;
};

export const removeSavedIp = (ip: string, port: number): SavedTunnelIp[] => {
  const next = readSavedIps().filter((e) => !(e.ip === ip && e.port === port));
  writeSavedIps(next);
  return next;
};

/** Drop every saved address of one device (used when it is unpaired). */
export const removeSavedIpsForUdid = (udid: string): SavedTunnelIp[] => {
  const next = readSavedIps().filter((e) => e.udid !== udid);
  writeSavedIps(next);
  return next;
};

/**
 * Entries worth trying on the LAN we're currently on, most recent first.
 * With no host prefix (offline, or the probe failed) every entry is a
 * candidate, which is the pre-issue-#48 behaviour.
 */
export const savedIpsForPrefix = (
  list: SavedTunnelIp[],
  hostPrefix: string | null,
): SavedTunnelIp[] => {
  const sorted = [...list].sort((a, b) => b.lastUsed - a.lastUsed);
  if (!hostPrefix) return sorted;
  // Entries written before the prefix tag existed are matched on the
  // prefix derived from their own IP, so an upgrade keeps working without
  // a migration step.
  return sorted.filter((e) => {
    const p = entryPrefix(e);
    // A malformed address has no prefix to compare; leave it in rather
    // than silently dropping something the user typed.
    return !p || p === hostPrefix;
  });
};
