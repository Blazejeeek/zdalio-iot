// Moduły typów urządzeń (docs/PROTOKOL.md, rozdział 6). Nowy typ = nowy wpis tutaj.
import type { JsonObject } from "./envelope.ts";

export interface Module {
  type: string;
  /** Wersje schematu `v` obsługiwane przez ten moduł. */
  versions: number[];
  /** Nazwy zdarzeń i walidacja ich `data`; wynik to powód odrzucenia albo null. */
  events: Record<string, (data: JsonObject) => string | null>;
  /** Telemetria przyjmowana, ale niezapisywana: kontrakt bazy obejmuje tylko tele/sys. */
  telemetry: string[];
  /** Polecenia i czas oczekiwania na `res` w milisekundach. */
  commands: Record<string, { timeoutMs: number }>;
}

const SSP_KINDS = new Set(["zdarzenie", "historia", "inne"]);
const HEX = /^([0-9a-fA-F]{2})*$/;

function validateSsp(data: JsonObject): string | null {
  if (typeof data.protokol !== "string" || data.protokol === "") return "ssp_bad_protokol";
  if (typeof data.rodzaj !== "string" || !SSP_KINDS.has(data.rodzaj)) return "ssp_bad_rodzaj";
  if (!Array.isArray(data.linie) || !data.linie.every((line) => typeof line === "string")) return "ssp_bad_linie";
  return null;
}

function validateRaw(data: JsonObject): string | null {
  if (typeof data.hex !== "string" || !HEX.test(data.hex)) return "raw_bad_hex";
  if (data.len !== data.hex.length / 2) return "raw_bad_len";
  return null;
}

export const MODULES: Record<string, Module> = {
  "e-print": {
    type: "e-print",
    versions: [1],
    events: { ssp: validateSsp, raw: validateRaw },
    telemetry: ["printer"],
    commands: { send: { timeoutMs: 15_000 } },
  },
  // Bez adaptera Shelly: ten powstanie razem z modułem bramy (krok 9 planu).
  "e-gate": {
    type: "e-gate",
    versions: [1],
    events: { input: () => null },
    telemetry: ["gate"],
    commands: { open: { timeoutMs: 5_000 } },
  },
};

export function selectModules(types: string[]): Module[] {
  if (types.length === 0) throw new Error("MODULES is empty");
  return [...new Set(types)].map((type) => {
    const module = MODULES[type];
    if (!module) throw new Error(`Unknown module in MODULES: ${type}`);
    return module;
  });
}
