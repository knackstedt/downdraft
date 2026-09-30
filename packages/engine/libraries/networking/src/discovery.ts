// ============================================================================
// discovery.ts — LAN service/session discovery.
//
// Two complementary mechanisms:
//
//   LanDiscovery — DownDraft-native beacon: JSON announce/query packets on
//   a UDP multicast group. Games advertise a session, joiners browse.
//   Zero external interop; both ends run this code.
//
//   MdnsBrowser — real mDNS/DNS-SD browse (PTR query → SRV/TXT/A via
//   dns-packet). For finding foreign services on the LAN — media servers,
//   Ember instances, printers, `services.google.com` cast targets, etc.
//
// Both use node:dgram (works on Node/Bun; Deno via node compat). When UDP
// is unavailable (sandboxed contexts) `create()` returns null — degrade to
// manual address entry.
// ============================================================================

import type { Socket } from "node:dgram";

type Dgram = typeof import("node:dgram");
type DnsPacket = typeof import("dns-packet");

// ── shared helpers ──

async function loadDgram(): Promise<Dgram | null> {
  try {
    return await import("node:dgram");
  } catch {
    return null;
  }
}

function openSocket(
  dgram: Dgram,
  port: number,
  group: string | null,
  onMsg: (buf: Buffer, rinfo: { address: string; port: number }) => void,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.on("error", reject);
    s.on("message", (buf, rinfo) => {
      try { onMsg(buf as Buffer, rinfo); } catch { /* malformed packet */ }
    });
    s.bind(port, () => {
      s.off("error", reject);
      try {
        if (group) s.addMembership(group);
        s.setMulticastTTL(4);
        resolve(s);
      } catch (e) {
        s.close();
        reject(e);
      }
    });
  });
}

// ── DownDraft beacon ──

export interface LanBeacon {
  /** Stable identity of the advertiser (persist per session). */
  id: string;
  /** Application tag — only beacons for the same `app` are browsed. */
  app: string;
  /** Display name ("Kaya's lobby"). */
  name: string;
  /** Service port the session listens on. */
  port: number;
  /** Free-form metadata (map, player count, version…). */
  meta?: Record<string, string>;
}

export interface LanPeer extends LanBeacon {
  host: string;
  lastSeenMs: number;
}

export interface LanDiscoveryOptions {
  /** Multicast group (default 239.255.77.77). */
  group?: string;
  /** UDP port (default 47777). */
  port?: number;
  /** Beacon interval ms (default 1200). */
  intervalMs?: number;
  /** Peer expiry — ms without a beacon before leave (default 5000). */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface BeaconPacket {
  v: 1; t: "beacon" | "query";
  app: string; id: string; name: string; port: number;
  meta?: Record<string, string>;
}

/**
 * UDP-multicast session directory. `advertise()` announces a session on a
 * timer; `browse()` lists live peers. A listener also answers `query`
 * packets so new joiners populate instantly instead of waiting a cycle.
 */
export class LanDiscovery {
  private sock: Socket;
  private opts: Required<Omit<LanDiscoveryOptions, "now">> & { now: () => number };
  private me: BeaconPacket | null = null;
  private peers = new Map<string, LanPeer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = {
    join: new Set<(p: LanPeer) => void>(),
    leave: new Set<(p: LanPeer) => void>(),
    update: new Set<(p: LanPeer) => void>(),
  };

  private constructor(sock: Socket, opts: LanDiscoveryOptions) {
    this.sock = sock;
    this.opts = {
      group: opts.group ?? "239.255.77.77",
      port: opts.port ?? 47777,
      intervalMs: opts.intervalMs ?? 1200,
      ttlMs: opts.ttlMs ?? 5000,
      now: opts.now ?? (() => Date.now()),
    };
  }

  /** Open the multicast socket; null when UDP is unavailable. */
  static async create(opts: LanDiscoveryOptions = {}): Promise<LanDiscovery | null> {
    const dgram = await loadDgram();
    if (!dgram) return null;
    const port = opts.port ?? 47777;
    const group = opts.group ?? "239.255.77.77";
    let inst: LanDiscovery | null = null;
    try {
      const sock = await openSocket(dgram, port, group, (buf, rinfo) => inst?.onPacket(buf, rinfo));
      inst = new LanDiscovery(sock, opts);
      inst.query(); // ask current advertisers to re-announce immediately
      return inst;
    } catch {
      return null;
    }
  }

  /** Start announcing this session; call again to update fields. */
  advertise(b: LanBeacon) {
    this.me = { v: 1, t: "beacon", ...b };
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    }
    this.sendBeacon();
  }

  stopAdvertising() {
    this.me = null;
  }

  /** Live peer table (excluding self), freshest first. */
  browse(): LanPeer[] {
    this.expire();
    return [...this.peers.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  }

  onJoin(fn: (p: LanPeer) => void): () => void { this.listeners.join.add(fn); return () => this.listeners.join.delete(fn); }
  onLeave(fn: (p: LanPeer) => void): () => void { this.listeners.leave.add(fn); return () => this.listeners.leave.delete(fn); }
  onUpdate(fn: (p: LanPeer) => void): () => void { this.listeners.update.add(fn); return () => this.listeners.update.delete(fn); }

  /** Manual expiry pass — called internally; exposed for manual pumps/tests. */
  tick() {
    this.expire();
    this.sendBeacon();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.sock.close(); } catch { /* already closed */ }
  }

  private sendBeacon() {
    if (!this.me) return;
    this.send({ ...this.me, t: "beacon" });
  }

  private query() {
    const me = this.me;
    this.send({ v: 1, t: "query", app: me?.app ?? "*", id: me?.id ?? "", name: "", port: 0 });
  }

  private send(pkt: BeaconPacket) {
    try {
      const buf = Buffer.from(JSON.stringify(pkt));
      this.sock.send(buf, this.opts.port, this.opts.group);
    } catch { /* send failure is transient */ }
  }

  private onPacket(buf: Buffer, rinfo: { address: string; port: number }) {
    let pkt: BeaconPacket;
    try { pkt = JSON.parse(buf.toString("utf8")); } catch { return; }
    if (pkt.v !== 1 || !pkt.app) return;
    if (pkt.t === "query") {
      if (this.me && (pkt.app === "*" || pkt.app === this.me.app)) this.sendBeacon();
      return;
    }
    if (pkt.t !== "beacon" || !pkt.id) return;
    if (this.me && pkt.id === this.me.id) return; // ignore self
    const existing = this.peers.get(pkt.id);
    const peer: LanPeer = { ...pkt, host: rinfo.address, lastSeenMs: this.opts.now() };
    this.peers.set(pkt.id, peer);
    if (!existing) for (const f of this.listeners.join) f(peer);
    else if (existing.name !== peer.name || existing.port !== peer.port
        || JSON.stringify(existing.meta) !== JSON.stringify(peer.meta)) {
      for (const f of this.listeners.update) f(peer);
    }
  }

  private expire() {
    const cutoff = this.opts.now() - this.opts.ttlMs;
    for (const [id, p] of this.peers) {
      if (p.lastSeenMs < cutoff) {
        this.peers.delete(id);
        for (const f of this.listeners.leave) f(p);
      }
    }
  }
}

// ── mDNS / DNS-SD browse ──

export interface MdnsService {
  /** Instance name from the PTR record ("Living Room TV"). */
  name: string;
  /** Service type browsed ("_smb._tcp.local"). */
  type: string;
  host: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
  /** Remaining TTL in ms (min over contributing records). */
  ttlMs: number;
  lastSeenMs: number;
}

export interface MdnsBrowseOptions {
  /** Re-query interval ms (default 30000). */
  intervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * One-shot + repeating mDNS browser. `query("_smb._tcp.local")` sends a PTR
 * question to 224.0.0.251:5353 and correlates SRV/TXT/A records into
 * `services()`. Entries expire on their DNS TTL.
 */
export class MdnsBrowser {
  private sock: Socket;
  private dns: DnsPacket;
  private opts: Required<Omit<MdnsBrowseOptions, "now">> & { now: () => number };
  private table = new Map<string, MdnsService>(); // key = `${name}.${type}`
  private timer: ReturnType<typeof setInterval> | null = null;
  private watched = new Set<string>();

  private constructor(sock: Socket, dns: DnsPacket, opts: MdnsBrowseOptions) {
    this.sock = sock;
    this.dns = dns;
    this.opts = { intervalMs: opts.intervalMs ?? 30000, now: opts.now ?? (() => Date.now()) };
  }

  /** null when UDP/dns-packet are unavailable. */
  static async create(opts: MdnsBrowseOptions = {}): Promise<MdnsBrowser | null> {
    const [dgram, dns] = await Promise.all([
      loadDgram(),
      import("dns-packet").catch(() => null),
    ]);
    if (!dgram || !dns) return null;
    let inst: MdnsBrowser | null = null;
    try {
      const sock = await openSocket(dgram, 5353, "224.0.0.251", (buf) => inst?.onPacket(buf));
      inst = new MdnsBrowser(sock, dns as DnsPacket, opts);
      inst.timer = setInterval(() => inst!.requery(), inst.opts.intervalMs);
      return inst;
    } catch {
      return null;
    }
  }

  /** Subscribe a service type; sends an immediate PTR query. */
  query(serviceType: string) {
    const type = serviceType.endsWith(".local") ? serviceType : `${serviceType}.local`;
    this.watched.add(type);
    this.sendQuery(type);
  }

  private requery() {
    for (const t of this.watched) this.sendQuery(t);
    this.expire();
  }

  private sendQuery(type: string) {
    try {
      const buf = this.dns.encode({
        type: "query",
        flags: 0, // standard query, no recursion — mDNS is multicast
        questions: [{ type: "PTR", name: type }],
      });
      this.sock.send(buf, 5353, "224.0.0.251");
    } catch { /* transient */ }
  }

  services(): MdnsService[] {
    this.expire();
    return [...this.table.values()];
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.sock.close(); } catch { /* closed */ }
  }

  private expire() {
    const now = this.opts.now();
    for (const [k, s] of this.table) {
      if (s.lastSeenMs + s.ttlMs < now) this.table.delete(k);
    }
  }

  /** Correlate PTR/SRV/TXT/A records into the service table. */
  private onPacket(buf: Buffer) {
    let pkt: ReturnType<DnsPacket["decode"]>;
    try { pkt = this.dns.decode(buf); } catch { return; }
    // Records that carry data (PTR/SRV/TXT/A) — OPT pseudo-records excluded.
    const recs = [...(pkt.answers ?? []), ...(pkt.additionals ?? [])]
      .filter((r): r is Extract<typeof r, { data: unknown }> => "data" in r);
    const now = this.opts.now();
    // PTR gives instance names; SRV/TXT/A for the same instance fill detail.
    for (const r of recs) {
      if (r.type !== "PTR" || !this.watched.has(r.name)) continue;
      const instance = r.data as string;
      const key = `${instance}@${r.name}`;
      const srv = recs.find((x) => x.type === "SRV" && x.name === instance);
      const txt = recs.find((x) => x.type === "TXT" && x.name === instance);
      const host = srv ? (srv.data as { target: string }).target : "";
      const addresses = recs
        .filter((x) => x.type === "A" && x.name === host)
        .map((x) => x.data as string);
      const ttlMin = Math.min(
        ...(recs.filter((x) => x.name === instance || x.name === r.name || x.name === host)
          .map((x) => x.ttl ?? 120)),
      );
      const txtMap: Record<string, string> = {};
      if (txt) {
        for (const item of (txt.data as Buffer[])) {
          const s = item.toString("utf8");
          const eq = s.indexOf("=");
          txtMap[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? "" : s.slice(eq + 1);
        }
      }
      const prev = this.table.get(key);
      this.table.set(key, {
        name: instance.replace(new RegExp(`\\.${r.name.replace(/\./g, "\\.")}$`), ""),
        type: r.name,
        host,
        port: srv ? (srv.data as { port: number }).port : 0,
        addresses,
        txt: txtMap,
        ttlMs: (ttlMin === Infinity ? 120 : ttlMin) * 1000,
        lastSeenMs: now,
      });
      void prev;
    }
  }
}
