import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import type { Config } from "./config.ts";
import { QUARANTINE_KIND, type ClaimedCommand, type CommandStatus, type Db } from "./db.ts";
import { parseJsonObject, validateEnvelope, validateResult, type Envelope, type JsonObject } from "./envelope.ts";
import { Metrics } from "./metrics.ts";
import { selectModules, type Module } from "./modules.ts";
import { ackTopic, commandTopic, isValidHwId, parseTopic, retainedFilters, sharedFilter, type ParsedTopic } from "./topic.ts";

const MAX_QUARANTINE_RAW = 2048;
const FINISH_ATTEMPTS = 3;
const COMMAND_NAME = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ level, msg, ...fields }));
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Health extends Record<string, unknown> {
  ok: boolean;
  mqtt: boolean;
  subscribed: boolean;
  db: boolean;
}

export class Bridge {
  readonly metrics = new Metrics();
  private readonly config: Config;
  private readonly db: Db;
  private readonly modules: Map<string, Module>;
  private client: MqttClient | undefined;
  private subscribed = false;
  private dbOk = true;
  private stopping = false;
  private polling = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private retainedTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;
  private readyResolve: (() => void) | undefined;
  /** Spełnia się po pierwszym udanym zasubskrybowaniu tematów. */
  readonly ready: Promise<void>;

  constructor(config: Config, db: Db) {
    this.config = config;
    this.db = db;
    this.modules = new Map(selectModules(config.modules).map((m) => [m.type, m]));
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  start(): void {
    const { config } = this;
    const options: IClientOptions = {
      clientId: `bridge-${config.instanceId}-${randomBytes(3).toString("hex")}`.slice(0, 64),
      username: config.mqttUsername,
      password: config.mqttPassword,
      protocolVersion: 4,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 2000,
      // Subskrypcje ustawia onConnect, także po każdym wznowieniu połączenia.
      resubscribe: false,
      queueQoSZero: false,
      ...(config.mqttCaFile ? { ca: readFileSync(config.mqttCaFile) } : {}),
    };
    const client = mqtt.connect(config.mqttUrl, options);
    this.client = client;
    client.on("connect", () => void this.onConnect(client));
    client.on("close", () => {
      this.subscribed = false;
    });
    client.on("error", (err) => log("error", "mqtt_error", { err: err.message }));
    client.on("message", (topic, payload) => this.onMessage(topic, payload));
    this.schedulePoll();
  }

  health(): Health {
    const mqttConnected = this.client?.connected ?? false;
    return {
      ok: mqttConnected && this.subscribed && this.dbOk && !this.stopping,
      mqtt: mqttConnected,
      subscribed: this.subscribed,
      db: this.dbOk,
      modules: [...this.modules.keys()],
      inflight: this.active,
      queued: this.queue.length,
      pendingCommands: this.pending.size,
    };
  }

  renderMetrics(): string {
    return this.metrics.render({
      bridge_up: 1,
      bridge_mqtt_connected: this.client?.connected ? 1 : 0,
      bridge_db_ok: this.dbOk ? 1 : 0,
      bridge_inflight: this.active,
      bridge_queue: this.queue.length,
      bridge_pending_commands: this.pending.size,
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.retainedTimer);
    const client = this.client;
    if (client?.connected) {
      const filters = [...this.modules.keys()].map(sharedFilter);
      await client.unsubscribeAsync(filters).catch((err) => log("warn", "unsubscribe_failed", { err: errorText(err) }));
    }
    const deadline = Date.now() + this.config.shutdownGraceMs;
    while ((this.active > 0 || this.queue.length > 0) && Date.now() < deadline) await sleep(20);
    // Wynik poleceń w toku jest nieznany; nigdy nie wysyłamy ich ponownie.
    await Promise.all([...this.pending.keys()].map((cid) => this.expirePending(cid, { reason: "bridge_shutdown" })));
    await client?.endAsync();
  }

  private async onConnect(client: MqttClient): Promise<void> {
    clearTimeout(this.retainedTimer);
    const types = [...this.modules.keys()];
    try {
      const granted = await client.subscribeAsync(types.map(sharedFilter), { qos: 1 });
      const denied = granted.filter((g) => g.qos > 2).map((g) => g.topic);
      if (denied.length > 0) throw new Error(`subscription denied: ${denied.join(", ")}`);
      this.subscribed = true;
      log("info", "subscribed", { types });
      this.readyResolve?.();
      await this.readRetainedState(client, types);
    } catch (err) {
      this.subscribed = false;
      this.metrics.inc("bridge_subscribe_errors_total");
      log("error", "subscribe_failed", { err: errorText(err) });
    }
  }

  /** $share nie dostaje wiadomości retained, więc stan odczytuje krótka zwykła subskrypcja (rozdział 5.1). */
  private async readRetainedState(client: MqttClient, types: string[]): Promise<void> {
    const filters = types.flatMap(retainedFilters);
    await client.subscribeAsync(filters, { qos: 1 });
    this.retainedTimer = setTimeout(() => {
      if (client.connected) {
        client.unsubscribeAsync(filters).catch((err) => log("warn", "unsubscribe_failed", { err: errorText(err) }));
      }
    }, this.config.retainedWindowMs);
  }

  private onMessage(topic: string, payload: Buffer): void {
    const parsed = parseTopic(topic);
    if (parsed?.channel.kind === "downstream") return;
    if (this.stopping) return;
    if (this.queue.length >= this.config.maxQueue) {
      // Urządzenie ponowi zdarzenie bez ack; telemetria może przepaść.
      this.metrics.inc("bridge_dropped_total");
      return;
    }
    this.queue.push(() => this.process(topic, parsed, payload));
    this.drain();
  }

  private drain(): void {
    while (this.active < this.config.maxInflight && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active += 1;
      task()
        .catch((err) => log("error", "task_failed", { err: errorText(err) }))
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private async process(topic: string, parsed: ParsedTopic | null, payload: Buffer): Promise<void> {
    if (!parsed) return this.quarantine(topic, payload, "bad_topic");
    const module = this.modules.get(parsed.type);
    if (!module) return this.quarantine(topic, payload, "unsupported_type");
    const { channel } = parsed;
    // Pusta treść na status/info to skasowanie wiadomości retained, nie błąd urządzenia.
    if ((channel.kind === "status" || channel.kind === "info") && payload.length === 0) return;

    const body = parseJsonObject(payload);
    if (!body.ok) return this.quarantine(topic, payload, body.reason);

    switch (channel.kind) {
      case "status":
        if (body.value.st !== "online" && body.value.st !== "offline") {
          return this.quarantine(topic, payload, "bad_status");
        }
        return this.saveState(parsed, "status", body.value);
      case "info":
        return this.saveState(parsed, "info", body.value);
      case "res":
        return this.handleResult(topic, payload, body.value);
      case "tele":
      case "evt": {
        const envelope = validateEnvelope(body.value);
        if (!envelope.ok) return this.quarantine(topic, payload, envelope.reason);
        if (!module.versions.includes(envelope.value.v)) return this.quarantine(topic, payload, "unsupported_version");
        if (channel.kind === "tele") return this.handleTelemetry(topic, payload, parsed, module, channel.name, envelope.value);
        return this.handleEvent(topic, payload, parsed, module, channel.name, envelope.value);
      }
      case "downstream":
        return;
    }
  }

  private async handleEvent(
    topic: string,
    payload: Buffer,
    parsed: ParsedTopic,
    module: Module,
    name: string,
    envelope: Envelope,
  ): Promise<void> {
    const validate = module.events[name];
    if (!validate) return this.quarantine(topic, payload, "unknown_event");
    const invalid = validate(envelope.data);
    if (invalid) return this.quarantine(topic, payload, invalid);

    let result;
    try {
      result = await this.db.ingestEvent({
        type: parsed.type,
        hwId: parsed.hwId,
        boot: envelope.boot,
        seq: envelope.seq,
        name,
        ts: envelope.ts,
        payload: envelope,
      });
      this.dbOk = true;
    } catch (err) {
      // Brak ack: urządzenie zachowa zdarzenie w buforze i wyśle je ponownie.
      this.dbOk = false;
      this.metrics.inc("bridge_events_total", { type: parsed.type, result: "db_error" });
      log("error", "ingest_event_failed", { topic, err: errorText(err) });
      return;
    }
    this.metrics.inc("bridge_events_total", { type: parsed.type, result });
    if (result === "stored" || result === "duplicate") {
      await this.sendAck(parsed, envelope);
    } else {
      log("warn", "event_not_acked", { topic, boot: envelope.boot, seq: envelope.seq, result });
    }
  }

  private async sendAck(parsed: ParsedTopic, envelope: Envelope): Promise<void> {
    try {
      const body = JSON.stringify({ boot: envelope.boot, seq: [envelope.seq] });
      await this.client!.publishAsync(ackTopic(parsed.type, parsed.hwId), body, { qos: 1, retain: false });
    } catch (err) {
      // Ponowne wysłanie zdarzenia skończy się duplikatem i kolejnym ack.
      this.metrics.inc("bridge_ack_errors_total");
      log("warn", "ack_failed", { err: errorText(err) });
    }
  }

  private handleTelemetry(
    topic: string,
    payload: Buffer,
    parsed: ParsedTopic,
    module: Module,
    name: string,
    envelope: Envelope,
  ): Promise<void> {
    if (name === "sys") return this.saveState(parsed, "tele/sys", envelope);
    if (!module.telemetry.includes(name)) return this.quarantine(topic, payload, "unknown_telemetry");
    this.metrics.inc("bridge_telemetry_ignored_total", { type: parsed.type, name });
    return Promise.resolve();
  }

  private async saveState(parsed: ParsedTopic, kind: string, payload: JsonObject): Promise<void> {
    try {
      await this.db.ingestState(parsed.type, parsed.hwId, kind, payload);
      this.dbOk = true;
      this.metrics.inc("bridge_state_total", { type: parsed.type, kind });
    } catch (err) {
      this.dbOk = false;
      this.metrics.inc("bridge_state_errors_total", { type: parsed.type, kind });
      log("error", "ingest_state_failed", { kind, err: errorText(err) });
    }
  }

  private async quarantine(topic: string, payload: Buffer, reason: string): Promise<void> {
    const [type = "", hwId = ""] = topic.split("/");
    this.metrics.inc("bridge_quarantine_total", { reason });
    log("warn", "quarantine", { topic, reason });
    try {
      await this.db.ingestState(type, hwId, QUARANTINE_KIND, {
        reason,
        topic,
        hw_id_valid: isValidHwId(hwId),
        raw: payload.toString("utf8", 0, MAX_QUARANTINE_RAW).replaceAll("\0", ""),
        size: payload.length,
        received_at: new Date().toISOString(),
      });
      this.dbOk = true;
    } catch (err) {
      this.dbOk = false;
      this.metrics.inc("bridge_quarantine_errors_total");
      log("error", "quarantine_failed", { topic, err: errorText(err) });
    }
  }

  private async handleResult(topic: string, payload: Buffer, body: JsonObject): Promise<void> {
    const result = validateResult(body);
    if (!result.ok) return this.quarantine(topic, payload, result.reason);
    const timer = this.pending.get(result.value.cid);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(result.value.cid);
    }
    // Wynik może przyjść do innej instancji niż ta, która wysłała polecenie.
    this.metrics.inc("bridge_command_results_total", { status: result.value.status });
    const known = await this.finishCommand(result.value.cid, result.value.status, body);
    if (!known) return this.quarantine(topic, payload, "unknown_cid");
  }

  private schedulePoll(): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      void this.pollCommands().finally(() => this.schedulePoll());
    }, this.config.commandPollMs);
  }

  private async pollCommands(): Promise<void> {
    if (this.polling || !this.client?.connected || !this.subscribed) return;
    this.polling = true;
    try {
      const commands = await this.db.claimCommands([...this.modules.keys()], this.config.commandBatch);
      this.dbOk = true;
      await Promise.all(commands.map((command) => this.dispatchCommand(command)));
    } catch (err) {
      this.dbOk = false;
      this.metrics.inc("bridge_claim_errors_total");
      log("error", "claim_commands_failed", { err: errorText(err) });
    } finally {
      this.polling = false;
    }
  }

  private async dispatchCommand(command: ClaimedCommand): Promise<void> {
    const { cid, type, hw_id: hwId, name, payload, expires_at: expiresAt } = command;
    const definition = this.modules.get(type)?.commands[name];
    if (!definition || !isValidHwId(hwId) || !COMMAND_NAME.test(name)) {
      await this.finishCommand(cid, "failed", { reason: "invalid_command" });
      return;
    }
    if (expiresAt === null) {
      await this.finishCommand(cid, "failed", { reason: "missing_exp" });
      return;
    }
    const exp = Math.floor(expiresAt.getTime() / 1000);
    if (exp <= Date.now() / 1000) {
      this.metrics.inc("bridge_commands_total", { type, result: "expired" });
      await this.finishCommand(cid, "expired", { reason: "expired_before_send" });
      return;
    }

    // Jedna publikacja na claim: polecenia nie są automatycznie ponawiane (rozdział 5.4).
    const timer = setTimeout(() => void this.expirePending(cid, { reason: "no_result" }), definition.timeoutMs);
    this.pending.set(cid, timer);
    try {
      const body = JSON.stringify({ v: 1, cid, exp, data: payload ?? {} });
      await this.client!.publishAsync(commandTopic(type, hwId, name), body, { qos: 1, retain: false });
      this.metrics.inc("bridge_commands_total", { type, result: "sent" });
    } catch (err) {
      clearTimeout(timer);
      if (this.pending.delete(cid)) {
        this.metrics.inc("bridge_commands_total", { type, result: "publish_error" });
        await this.finishCommand(cid, "failed", { reason: "publish_failed", err: errorText(err) });
      }
    }
  }

  private async expirePending(cid: string, result: JsonObject): Promise<void> {
    const timer = this.pending.get(cid);
    if (!timer) return;
    clearTimeout(timer);
    this.pending.delete(cid);
    this.metrics.inc("bridge_command_results_total", { status: "timeout" });
    await this.finishCommand(cid, "timeout", result);
  }

  /** Ponawia tylko zapis wyniku w bazie, nigdy samo polecenie. */
  private async finishCommand(cid: string, status: CommandStatus, result: JsonObject): Promise<boolean> {
    for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt += 1) {
      try {
        const known = await this.db.finishCommand(cid, status, result);
        this.dbOk = true;
        return known;
      } catch (err) {
        this.dbOk = false;
        this.metrics.inc("bridge_finish_errors_total");
        log("error", "finish_command_failed", { cid, status, attempt, err: errorText(err) });
        if (attempt < FINISH_ATTEMPTS) await sleep(this.config.finishRetryMs);
      }
    }
    return true;
  }
}
