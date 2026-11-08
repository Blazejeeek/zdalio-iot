import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { Aedes, type Client } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { Bridge } from "../src/bridge.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import type { ClaimedCommand, CommandStatus, Db, IngestEvent, IngestResult } from "../src/db.ts";
import type { JsonObject } from "../src/envelope.ts";

export const HW = "7K3M9QXT4AB";
export const HW2 = "7K3M9QXT4AC";

export function matches(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === "#") return true;
    if (t[i] === undefined || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/** Aedes nie zna $share: rozdzielacz odwzorowuje grupę (jeden odbiorca, bez retained). */
function attachSharedSubscriptions(broker: Aedes): void {
  const groups = new Map<string, { filter: string; members: Client[]; next: number }>();
  broker.on("subscribe", (subs, client) => {
    for (const { topic } of subs) {
      const m = /^\$share\/([^/]+)\/(.+)$/.exec(topic);
      if (!m) continue;
      const group = groups.get(topic) ?? { filter: m[2]!, members: [], next: 0 };
      group.members.push(client);
      groups.set(topic, group);
    }
  });
  const remove = (client: Client, topic?: string) => {
    for (const [key, group] of groups) {
      if (topic === undefined || topic === key) group.members = group.members.filter((c) => c !== client);
    }
  };
  broker.on("unsubscribe", (topics, client) => topics.forEach((t) => remove(client, t)));
  broker.on("clientDisconnect", (client) => remove(client));
  broker.on("publish", (packet, client) => {
    if (!client) return;
    for (const group of groups.values()) {
      if (group.members.length === 0 || !matches(group.filter, packet.topic)) continue;
      const target = group.members[group.next++ % group.members.length]!;
      target.publish({ cmd: "publish", topic: packet.topic, payload: packet.payload, qos: 0, retain: false, dup: false }, () => {});
    }
  });
}

export class FakeDb implements Db {
  readonly devices = new Map<string, string>([[HW, "e-print"], [HW2, "e-print"]]);
  readonly events = new Map<string, IngestEvent>();
  readonly quarantined: JsonObject[] = [];
  readonly states: Array<{ type: string; hwId: string; kind: string; payload: JsonObject }> = [];
  readonly results = new Map<string, { status: CommandStatus; result: JsonObject }>();
  commands: ClaimedCommand[] = [];
  readonly claimed = new Set<string>();
  ingestCalls = 0;
  failing = false;

  private check(): void {
    if (this.failing) throw new Error("database down");
  }

  async ingestEvent(e: IngestEvent): Promise<IngestResult> {
    this.ingestCalls += 1;
    this.check();
    if (this.devices.get(e.hwId) !== e.type) {
      this.quarantined.push({ reason: "type_mismatch", hw: e.hwId, type: e.type });
      return "quarantined";
    }
    const key = `${e.hwId}|${e.boot}|${e.seq}`;
    const existing = this.events.get(key);
    if (!existing) {
      this.events.set(key, e);
      return "stored";
    }
    return JSON.stringify(existing.payload.data) === JSON.stringify(e.payload.data) ? "duplicate" : "conflict";
  }

  async ingestState(type: string, hwId: string, kind: string, payload: JsonObject): Promise<void> {
    this.check();
    if (kind === "quarantine") this.quarantined.push(payload);
    else this.states.push({ type, hwId, kind, payload });
  }

  async claimCommands(types: string[], limit: number): Promise<ClaimedCommand[]> {
    this.check();
    const claimed = this.commands.filter((c) => types.includes(c.type)).slice(0, limit);
    this.commands = this.commands.filter((c) => !claimed.includes(c));
    for (const c of claimed) this.claimed.add(c.cid);
    return claimed;
  }

  // Wymagane od funkcji SQL: pierwszy końcowy wynik wygrywa.
  async finishCommand(cid: string, status: CommandStatus, result: JsonObject): Promise<boolean> {
    this.check();
    if (!this.claimed.has(cid)) return false;
    if (!this.results.has(cid)) this.results.set(cid, { status, result });
    return true;
  }

  async close(): Promise<void> {}
}

export interface Rig {
  url: string;
  broker: Aedes;
  bridge(db: Db, overrides?: Partial<Config>): Promise<Bridge>;
  device(subscribe?: string[]): Promise<MqttClient>;
  close(): Promise<void>;
}

export async function createRig(): Promise<Rig> {
  const broker = await Aedes.createBroker();
  attachSharedSubscriptions(broker);
  const server: Server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bridges: Bridge[] = [];
  const clients: MqttClient[] = [];
  return {
    url,
    broker,
    async bridge(db, overrides = {}) {
      const bridge = new Bridge(
        { ...DEFAULTS, mqttUrl: url, databaseUrl: "", modules: ["e-print"], instanceId: `t${bridges.length}`,
          commandPollMs: 20, retainedWindowMs: 200, shutdownGraceMs: 500, finishRetryMs: 10, ...overrides },
        db,
      );
      bridges.push(bridge);
      bridge.start();
      await bridge.ready;
      return bridge;
    },
    async device(subscribe = []) {
      const client = await mqtt.connectAsync(url, { protocolVersion: 4, reconnectPeriod: 0 });
      clients.push(client);
      if (subscribe.length > 0) await client.subscribeAsync(subscribe, { qos: 1 });
      return client;
    },
    async close() {
      await Promise.all(bridges.map((b) => b.stop()));
      await Promise.all(clients.map((c) => c.endAsync()));
      await new Promise<void>((resolve) => broker.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function envelope(seq: number, data: JsonObject = ssp(), over: JsonObject = {}): string {
  return JSON.stringify({ v: 1, boot: "a1b2c3d4", seq, ts: "2026-11-03T18:40:00.123Z", ts_ok: true, up_ms: 5, data, ...over });
}

export function ssp(nr = 9000): JsonObject {
  return { protokol: "bosch-ssp", rodzaj: "zdarzenie", nr, linie: [`${nr} Detektor`] };
}

export async function waitFor(check: () => boolean, label = "condition", timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

export function collect(client: MqttClient): Array<{ topic: string; body: any }> {
  const out: Array<{ topic: string; body: any }> = [];
  client.on("message", (topic, payload) => out.push({ topic, body: JSON.parse(payload.toString()) }));
  return out;
}
