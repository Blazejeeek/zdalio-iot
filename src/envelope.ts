// Walidacja treści wiadomości wg docs/PROTOKOL.md, rozdziały 4 i 5.

export const MAX_PAYLOAD_BYTES = 1024;

const BOOT = /^[0-9a-f]{8}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export type JsonObject = Record<string, unknown>;
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface Envelope extends JsonObject {
  v: number;
  boot: string;
  seq: number;
  ts: string | null;
  ts_ok: boolean;
  up_ms: number;
  sub?: string;
  data: JsonObject;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const fail = (reason: string) => ({ ok: false, reason }) as const;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function parseJsonObject(payload: Buffer): Result<JsonObject> {
  if (payload.length > MAX_PAYLOAD_BYTES) return fail("too_large");
  const text = payload.toString("utf8");
  // PostgreSQL odrzuca \u0000 w jsonb: taka wiadomość blokowałaby się w nieskończoność.
  if (text.includes("\\u0000") || text.includes("\0")) return fail("nul_character");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }
  return isObject(parsed) ? { ok: true, value: parsed } : fail("not_an_object");
}

export function validateEnvelope(body: JsonObject): Result<Envelope> {
  const { v, boot, seq, ts, ts_ok: tsOk, up_ms: upMs, sub, data } = body;
  if (!isCount(v)) return fail("bad_v");
  if (typeof boot !== "string" || !BOOT.test(boot)) return fail("bad_boot");
  if (!isCount(seq)) return fail("bad_seq");
  if (typeof tsOk !== "boolean") return fail("bad_ts_ok");
  if (tsOk) {
    if (typeof ts !== "string" || !ISO_UTC.test(ts) || Number.isNaN(Date.parse(ts))) return fail("bad_ts");
  } else if (ts !== null) {
    return fail("bad_ts");
  }
  if (!isCount(upMs)) return fail("bad_up_ms");
  if (sub !== undefined && typeof sub !== "string") return fail("bad_sub");
  if (!isObject(data)) return fail("bad_data");
  return { ok: true, value: body as Envelope };
}

export type ResultStatus = "done" | "failed" | "expired";

const RESULT_STATUS: Record<string, ResultStatus> = {
  ok: "done",
  err: "failed",
  busy: "failed",
  unsupported: "failed",
  expired: "expired",
};

export function validateResult(body: JsonObject): Result<{ cid: string; status: ResultStatus }> {
  if (typeof body.cid !== "string" || body.cid === "") return fail("bad_cid");
  const status = typeof body.st === "string" ? RESULT_STATUS[body.st] : undefined;
  return status ? { ok: true, value: { cid: body.cid, status } } : fail("bad_st");
}
