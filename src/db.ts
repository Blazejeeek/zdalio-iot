// Jedyny styk z bazą: funkcje z docs/PROTOKOL.md, rozdział 11.
import pg from "pg";
import type { JsonObject } from "./envelope.ts";

export type IngestResult = "stored" | "duplicate" | "conflict" | "quarantined";
export type CommandStatus = "done" | "failed" | "expired" | "timeout";

export interface ClaimedCommand {
  cid: string;
  type: string;
  hw_id: string;
  name: string;
  payload: JsonObject;
  expires_at: Date | null;
}

export interface IngestEvent {
  type: string;
  hwId: string;
  boot: string;
  seq: number;
  name: string;
  ts: string | null;
  payload: JsonObject;
}

export interface Db {
  ingestEvent(event: IngestEvent): Promise<IngestResult>;
  ingestState(type: string, hwId: string, kind: string, payload: JsonObject): Promise<void>;
  claimCommands(types: string[], limit: number): Promise<ClaimedCommand[]>;
  /** Wynik false oznacza nieznany `cid`. */
  finishCommand(cid: string, status: CommandStatus, result: JsonObject): Promise<boolean>;
  close(): Promise<void>;
}

/** Baza zapisuje stan o nieznanym rodzaju w iot.quarantine razem z całą treścią (powód bad_kind). */
export const QUARANTINE_KIND = "quarantine";

const UNKNOWN_COMMAND = "PT404";

type Queryable = Pick<pg.Pool, "query">;

export class PgDb implements Db {
  private readonly pool: Queryable & { end?: () => Promise<void> };

  constructor(pool: Queryable & { end?: () => Promise<void> }) {
    this.pool = pool;
  }

  static fromUrl(connectionString: string): PgDb {
    const pool = new pg.Pool({ connectionString, max: 10, statement_timeout: 10_000 });
    // Bez tej obsługi błąd bezczynnego połączenia kończy cały proces.
    pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "pg_idle_error", err: err.message })));
    return new PgDb(pool);
  }

  async ingestEvent(e: IngestEvent): Promise<IngestResult> {
    const res = await this.pool.query<{ result: IngestResult }>(
      "select iot.ingest_event($1, $2, $3, $4, $5, $6, $7::jsonb) as result",
      [e.type, e.hwId, e.boot, e.seq, e.name, e.ts, JSON.stringify(e.payload)],
    );
    const result = res.rows[0]?.result;
    if (!result) throw new Error("ingest_event returned no result");
    return result;
  }

  async ingestState(type: string, hwId: string, kind: string, payload: JsonObject): Promise<void> {
    await this.pool.query("select iot.ingest_state($1, $2, $3, $4::jsonb)", [type, hwId, kind, JSON.stringify(payload)]);
  }

  async claimCommands(types: string[], limit: number): Promise<ClaimedCommand[]> {
    const res = await this.pool.query<ClaimedCommand>("select * from iot.claim_commands($1::text[], $2)", [types, limit]);
    return res.rows;
  }

  async finishCommand(cid: string, status: CommandStatus, result: JsonObject): Promise<boolean> {
    try {
      await this.pool.query("select iot.finish_command($1, $2, $3::jsonb)", [cid, status, JSON.stringify(result)]);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === UNKNOWN_COMMAND) return false;
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}
