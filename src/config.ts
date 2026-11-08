import { hostname } from "node:os";

export interface Config {
  mqttUrl: string;
  mqttUsername?: string;
  mqttPassword?: string;
  mqttCaFile?: string;
  databaseUrl: string;
  modules: string[];
  httpPort: number;
  instanceId: string;
  commandPollMs: number;
  commandBatch: number;
  retainedWindowMs: number;
  maxInflight: number;
  maxQueue: number;
  shutdownGraceMs: number;
  finishRetryMs: number;
}

export const DEFAULTS = {
  httpPort: 8080,
  commandPollMs: 1000,
  commandBatch: 20,
  retainedWindowMs: 3000,
  maxInflight: 32,
  maxQueue: 2000,
  shutdownGraceMs: 10_000,
  finishRetryMs: 1000,
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid number in ${name}: ${raw}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    mqttUrl: required(env, "MQTT_URL"),
    mqttUsername: env.MQTT_USERNAME,
    mqttPassword: env.MQTT_PASSWORD,
    mqttCaFile: env.MQTT_CA_FILE,
    databaseUrl: required(env, "DATABASE_URL"),
    modules: required(env, "MODULES").split(",").map((s) => s.trim()).filter(Boolean),
    httpPort: number(env, "HTTP_PORT", DEFAULTS.httpPort),
    instanceId: env.INSTANCE_ID || hostname(),
    commandPollMs: number(env, "COMMAND_POLL_MS", DEFAULTS.commandPollMs),
    commandBatch: number(env, "COMMAND_BATCH", DEFAULTS.commandBatch),
    retainedWindowMs: number(env, "RETAINED_WINDOW_MS", DEFAULTS.retainedWindowMs),
    maxInflight: number(env, "MAX_INFLIGHT", DEFAULTS.maxInflight),
    maxQueue: number(env, "MAX_QUEUE", DEFAULTS.maxQueue),
    shutdownGraceMs: number(env, "SHUTDOWN_GRACE_MS", DEFAULTS.shutdownGraceMs),
    finishRetryMs: number(env, "FINISH_RETRY_MS", DEFAULTS.finishRetryMs),
  };
}
