import { createServer, type Server } from "node:http";
import type { Bridge } from "./bridge.ts";

export function startHttp(bridge: Bridge, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      const health = bridge.health();
      res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(health));
    } else if (req.method === "GET" && path === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(bridge.renderMetrics());
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}
