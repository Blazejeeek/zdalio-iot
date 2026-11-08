import { Bridge } from "./bridge.ts";
import { loadConfig } from "./config.ts";
import { PgDb } from "./db.ts";
import { startHttp } from "./http.ts";

const config = loadConfig(process.env);
const db = PgDb.fromUrl(config.databaseUrl);
const bridge = new Bridge(config, db);
const server = await startHttp(bridge, config.httpPort);
bridge.start();

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await bridge.stop();
  await db.close();
  server.close();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
