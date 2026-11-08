import assert from "node:assert/strict";
import { it } from "node:test";
import { PgDb } from "../src/db.ts";

function pool(rows: unknown[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return { calls, query: async (text: string, values: unknown[]) => { calls.push({ text, values }); return { rows }; } };
}

it("PgDb: nieznany cid (PT404) to false, inny błąd leci dalej", async () => {
  const failing = (code: string) => ({ query: async () => { throw Object.assign(new Error("x"), { code }); } });
  assert.equal(await new PgDb(failing("PT404") as never).finishCommand("c", "done", {}), false);
  await assert.rejects(new PgDb(failing("08006") as never).finishCommand("c", "done", {}));
});

it("PgDb woła tylko funkcje z rozdziału 11", async () => {
  const p = pool([{ result: "stored" }]);
  const db = new PgDb(p as never);
  const result = await db.ingestEvent({ type: "e-print", hwId: "H", boot: "b", seq: 3, name: "ssp", ts: null, payload: { a: 1 } });
  assert.equal(result, "stored");
  await db.ingestState("e-print", "H", "status", { st: "online" });
  await db.claimCommands(["e-print"], 5);
  await db.finishCommand("c", "done", {});
  assert.deepEqual(p.calls[0]!.values, ["e-print", "H", "b", 3, "ssp", null, '{"a":1}']);
  assert.deepEqual(p.calls.map((c) => /iot\.(\w+)/.exec(c.text)![1]), ["ingest_event", "ingest_state", "claim_commands", "finish_command"]);
});
