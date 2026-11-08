import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startHttp } from "../src/http.ts";
import { selectModules } from "../src/modules.ts";
import { collect, createRig, envelope, FakeDb, HW, HW2, settle, ssp, waitFor, type Rig } from "./harness.ts";

const EVT = `e-print/${HW}/v1/evt/ssp`;
const ACK = `e-print/${HW}/v1/ack`;
const inFuture = (s = 60) => new Date(Date.now() + s * 1000);

describe("most", () => {
  let rig: Rig;
  let db: FakeDb;
  beforeEach(async () => {
    rig = await createRig();
    db = new FakeDb();
  });
  afterEach(() => rig.close());

  it("zapisuje zdarzenie i potwierdza je dopiero po zapisie", async () => {
    await rig.bridge(db);
    const device = await rig.device([ACK]);
    const acks = collect(device);
    await device.publishAsync(EVT, envelope(1), { qos: 1 });
    await waitFor(() => acks.length === 1, "ack");
    assert.deepEqual(acks[0]!.body, { boot: "a1b2c3d4", seq: [1] });
    const stored = db.events.get(`${HW}|a1b2c3d4|1`);
    assert.equal(stored?.name, "ssp");
    assert.equal(stored?.ts, "2026-11-03T18:40:00.123Z");
  });

  it("duplikat: drugi ack, jeden rekord", async () => {
    await rig.bridge(db);
    const device = await rig.device([ACK]);
    const acks = collect(device);
    await device.publishAsync(EVT, envelope(1), { qos: 1 });
    await waitFor(() => acks.length === 1, "pierwszy ack");
    await device.publishAsync(EVT, envelope(1), { qos: 1 });
    await waitFor(() => acks.length === 2, "drugi ack");
    assert.equal(db.events.size, 1);
    assert.equal(db.ingestCalls, 2);
  });

  it("ta sama para (boot, seq) z inną treścią: brak ack, rekord bez zmian", async () => {
    const bridge = await rig.bridge(db);
    const device = await rig.device([ACK]);
    const acks = collect(device);
    await device.publishAsync(EVT, envelope(1, ssp(1)), { qos: 1 });
    await waitFor(() => acks.length === 1, "ack");
    await device.publishAsync(EVT, envelope(1, ssp(2)), { qos: 1 });
    await waitFor(() => bridge.metrics.get('bridge_events_total{type="e-print",result="conflict"}') === 1, "konflikt");
    await settle();
    assert.equal(acks.length, 1);
    assert.equal(db.events.get(`${HW}|a1b2c3d4|1`)?.payload.data && (db.events.get(`${HW}|a1b2c3d4|1`)!.payload.data as any).nr, 1);
  });

  for (const [name, payload, reason] of [
    ["niepoprawny JSON", "{nie json", "invalid_json"],
    ["brak seq", JSON.stringify({ v: 1, boot: "a1b2c3d4", ts: null, ts_ok: false, up_ms: 1, data: {} }), "bad_seq"],
    ["zły boot", envelope(1, ssp(), { boot: "XYZ" }), "bad_boot"],
    ["ts_ok bez czasu", envelope(1, ssp(), { ts: null }), "bad_ts"],
    ["za długa treść", envelope(1, { ...ssp(), x: "a".repeat(1100) }), "too_large"],
    ["znak NUL", envelope(1, { ...ssp(), x: "\0" }), "nul_character"],
    ["zły schemat modułu", envelope(1, { protokol: "bosch-ssp" }), "ssp_bad_rodzaj"],
    ["nieobsługiwana wersja", envelope(1, ssp(), { v: 9 }), "unsupported_version"],
  ] as const) {
    it(`kwarantanna: ${name}`, async () => {
      await rig.bridge(db);
      const device = await rig.device([ACK]);
      const acks = collect(device);
      await device.publishAsync(EVT, payload, { qos: 1 });
      await waitFor(() => db.quarantined.length === 1, "kwarantanna");
      assert.equal(db.quarantined[0]!.reason, reason);
      assert.equal(db.quarantined[0]!.topic, EVT);
      await settle();
      assert.equal(acks.length, 0);
      assert.equal(db.events.size, 0);
    });
  }

  it("kwarantanna: nieznane zdarzenie i zły numer w temacie", async () => {
    await rig.bridge(db);
    const device = await rig.device();
    await device.publishAsync(`e-print/${HW}/v1/evt/nieznane`, envelope(1), { qos: 1 });
    await device.publishAsync("e-print/maly-numer/v1/evt/ssp", envelope(2), { qos: 1 });
    await waitFor(() => db.quarantined.length === 2, "kwarantanna");
    assert.deepEqual(db.quarantined.map((q) => q.reason).sort(), ["bad_topic", "unknown_event"]);
  });

  it("niezgodność typu z bazą: brak ack", async () => {
    await rig.bridge(db, { modules: ["e-print", "e-gate"] });
    const device = await rig.device([`e-gate/${HW}/v1/ack`]);
    const acks = collect(device);
    await device.publishAsync(`e-gate/${HW}/v1/evt/input`, envelope(1, {}), { qos: 1 });
    await waitFor(() => db.quarantined.length === 1, "kwarantanna");
    assert.equal(db.quarantined[0]!.reason, "type_mismatch");
    await settle();
    assert.equal(acks.length, 0);
  });

  it("awaria bazy: brak ack, a po naprawie ponowienie jest zapisane", async () => {
    const bridge = await rig.bridge(db);
    const device = await rig.device([ACK]);
    const acks = collect(device);
    db.failing = true;
    await device.publishAsync(EVT, envelope(1), { qos: 1 });
    await waitFor(() => db.ingestCalls === 1, "próba zapisu");
    await settle();
    assert.equal(acks.length, 0);
    assert.equal(bridge.health().ok, false);
    db.failing = false;
    await device.publishAsync(EVT, envelope(1), { qos: 1 });
    await waitFor(() => acks.length === 1, "ack po naprawie");
    assert.equal(db.events.size, 1);
    await waitFor(() => bridge.health().ok, "powrót zdrowia");
  });

  it("dwie instancje: każde zdarzenie zapisane i potwierdzone raz", async () => {
    const [a, b] = [await rig.bridge(db), await rig.bridge(db)];
    const device = await rig.device([ACK]);
    const acks = collect(device);
    for (let seq = 1; seq <= 100; seq += 1) await device.publishAsync(EVT, envelope(seq), { qos: 1 });
    await waitFor(() => acks.length >= 100, "100 ack");
    await settle();
    assert.equal(db.events.size, 100);
    assert.equal(db.ingestCalls, 100);
    assert.equal(acks.length, 100);
    assert.equal(new Set(acks.map((x) => x.body.seq[0])).size, 100);
    const stored = (x: typeof a) => x.metrics.get('bridge_events_total{type="e-print",result="stored"}');
    assert.ok(stored(a) > 0 && stored(b) > 0, `podział ${stored(a)}/${stored(b)}`);
  });

  it("MODULES: instancja obsługuje tylko swoje typy", async () => {
    await rig.bridge(db, { modules: ["e-gate"] });
    const device = await rig.device();
    await device.publishAsync(EVT, envelope(1), { qos: 1 });
    await settle();
    assert.equal(db.ingestCalls, 0);
    assert.throws(() => selectModules(["e-nieznany"]), /Unknown module/);
  });

  it("odczytuje retained status po starcie i nie reaguje na własne ack", async () => {
    const device = await rig.device();
    await device.publishAsync(`e-print/${HW}/v1/status`, JSON.stringify({ st: "online", boot: "a1b2c3d4" }), { qos: 1, retain: true });
    await device.publishAsync(`e-print/${HW2}/v1/info`, JSON.stringify({ fw: "1" }), { qos: 1, retain: true });
    await rig.bridge(db);
    await waitFor(() => db.states.length === 2, "stan retained");
    assert.deepEqual(db.states.map((s) => s.kind).sort(), ["info", "status"]);
    await settle(300);
    assert.equal(db.quarantined.length, 0);
  });

  it("tele/sys trafia do stanu, tele/printer jest tylko liczona", async () => {
    const bridge = await rig.bridge(db);
    const device = await rig.device();
    await device.publishAsync(`e-print/${HW}/v1/tele/sys`, envelope(1, { rssi: -50 }));
    await device.publishAsync(`e-print/${HW}/v1/tele/printer`, envelope(2, {}));
    await waitFor(() => bridge.metrics.get('bridge_telemetry_ignored_total{type="e-print",name="printer"}') === 1, "tele");
    await waitFor(() => db.states.length === 1, "tele/sys");
    assert.equal(db.states[0]!.kind, "tele/sys");
  });

  describe("polecenia", () => {
    const command = (over = {}) => ({ cid: "01JC", type: "e-gate", hw_id: HW, name: "open", payload: { pulse_ms: 800 }, expires_at: inFuture(), ...over });
    const cmdTopic = `e-gate/${HW}/v1/cmd/open`;
    const gate = { modules: ["e-gate"] };

    it("wysyła z exp, bez retain, a res kończy polecenie", async () => {
      await rig.bridge(db, gate);
      const device = await rig.device([cmdTopic]);
      const got: any[] = [];
      device.on("message", (_t, p, packet) => got.push({ body: JSON.parse(p.toString()), retain: packet.retain }));
      const expires = inFuture();
      const exp = Math.floor(expires.getTime() / 1000);
      db.commands.push(command({ expires_at: expires }));
      await waitFor(() => got.length === 1, "polecenie");
      assert.deepEqual(got[0], { body: { v: 1, cid: "01JC", exp, data: { pulse_ms: 800 } }, retain: false });
      await device.publishAsync(`e-gate/${HW}/v1/res`, JSON.stringify({ cid: "01JC", st: "ok", data: { limit: "open" } }), { qos: 1 });
      await waitFor(() => db.results.has("01JC"), "wynik");
      assert.equal(db.results.get("01JC")!.status, "done");
    });

    it("polecenie po terminie nie jest wysyłane", async () => {
      await rig.bridge(db, gate);
      const device = await rig.device([cmdTopic]);
      const got = collect(device);
      db.commands.push(command({ expires_at: inFuture(-5) }));
      await waitFor(() => db.results.has("01JC"), "wynik");
      assert.equal(db.results.get("01JC")!.status, "expired");
      await settle();
      assert.equal(got.length, 0);
    });

    it("brak exp: polecenie nie jest wysyłane", async () => {
      await rig.bridge(db, gate);
      const device = await rig.device([cmdTopic]);
      const got = collect(device);
      db.commands.push(command({ expires_at: null }));
      await waitFor(() => db.results.has("01JC"), "wynik");
      assert.equal(db.results.get("01JC")!.status, "failed");
      assert.equal(got.length, 0);
    });

    it("brak res: timeout bez ponownego wysłania, spóźniony wynik nie nadpisuje", async (t) => {
      const { MODULES } = await import("../src/modules.ts");
      const open = MODULES["e-gate"]!.commands.open!;
      const original = open.timeoutMs;
      open.timeoutMs = 80;
      t.after(() => { open.timeoutMs = original; });
      await rig.bridge(db, gate);
      const device = await rig.device([cmdTopic]);
      const got = collect(device);
      db.commands.push(command());
      await waitFor(() => db.results.has("01JC"), "timeout");
      assert.equal(db.results.get("01JC")!.status, "timeout");
      await settle(200);
      assert.equal(got.length, 1);
      await device.publishAsync(`e-gate/${HW}/v1/res`, JSON.stringify({ cid: "01JC", st: "ok" }), { qos: 1 });
      await settle();
      assert.equal(db.results.get("01JC")!.status, "timeout");
    });

    it("res z nieznanym cid: kwarantanna, zdrowie bez zmian", async () => {
      const bridge = await rig.bridge(db, gate);
      const device = await rig.device();
      await device.publishAsync(`e-gate/${HW}/v1/res`, JSON.stringify({ cid: "OBCY", st: "ok" }), { qos: 1 });
      await waitFor(() => db.quarantined.length === 1, "kwarantanna");
      assert.equal(db.quarantined[0]!.reason, "unknown_cid");
      assert.equal(bridge.health().ok, true);
    });

    it("wynik przyjęty przez inną instancję kończy polecenie", async () => {
      await Promise.all([rig.bridge(db, gate), rig.bridge(db, gate)]);
      const device = await rig.device([cmdTopic]);
      db.commands.push(command());
      await waitFor(() => db.commands.length === 0, "claim");
      for (const st of ["ok", "ok"]) await device.publishAsync(`e-gate/${HW}/v1/res`, JSON.stringify({ cid: "01JC", st }), { qos: 1 });
      await waitFor(() => db.results.has("01JC"), "wynik");
      assert.equal(db.results.get("01JC")!.status, "done");
    });
  });

  it("/health i /metrics", async () => {
    const bridge = await rig.bridge(db);
    const server = await startHttp(bridge, 0);
    const { port } = server.address() as { port: number };
    try {
      const device = await rig.device();
      await device.publishAsync(EVT, envelope(1), { qos: 1 });
      await waitFor(() => db.events.size === 1, "zapis");
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
      await settle(20);
      const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      assert.match(metrics, /bridge_events_total\{type="e-print",result="stored"\} 1/);
      db.failing = true;
      await waitFor(() => !bridge.health().ok, "wykrycie awarii");
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 503);
    } finally {
      server.close();
    }
  });
});
