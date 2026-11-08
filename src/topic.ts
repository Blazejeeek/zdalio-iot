// Tematy wg docs/PROTOKOL.md, rozdział 3: <typ>/<hw_id>/v1/<kanał>[/<nazwa>...]

const HW_ID = /^[0-9A-HJKMNP-TV-Z]{10}[0-9A-Z*~$=]$/;

export type Channel =
  | { kind: "status" | "info" | "res" }
  | { kind: "tele" | "evt"; name: string }
  | { kind: "downstream" };

export interface ParsedTopic {
  type: string;
  hwId: string;
  channel: Channel;
}

export function isValidHwId(value: string): boolean {
  return HW_ID.test(value);
}

export function parseTopic(topic: string): ParsedTopic | null {
  const [type, hwId, version, channel, ...rest] = topic.split("/");
  if (!type || !hwId || version !== "v1" || !channel || !isValidHwId(hwId)) return null;
  const base = { type, hwId };
  const name = rest.join("/");
  switch (channel) {
    case "status":
    case "info":
    case "res":
      return rest.length === 0 ? { ...base, channel: { kind: channel } } : null;
    case "tele":
    case "evt":
      return name ? { ...base, channel: { kind: channel, name } } : null;
    // Własne publikacje mostu wracają przez subskrypcję <typ>/+/v1/#.
    case "ack":
    case "cfg":
    case "cmd":
      return { ...base, channel: { kind: "downstream" } };
    default:
      return null;
  }
}

export function ackTopic(type: string, hwId: string): string {
  return `${type}/${hwId}/v1/ack`;
}

export function commandTopic(type: string, hwId: string, name: string): string {
  return `${type}/${hwId}/v1/cmd/${name}`;
}

export function sharedFilter(type: string): string {
  return `$share/${type}/${type}/+/v1/#`;
}

export function retainedFilters(type: string): string[] {
  return [`${type}/+/v1/status`, `${type}/+/v1/info`];
}
