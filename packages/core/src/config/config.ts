/**
 * Codriver configuration: the user's model fleet and routing knobs.
 *
 * The config lives in its own file (`~/.config/codriver/config.json` by
 * default, or `$CODRIVER_CONFIG`) — deliberately NOT inside any agent's own
 * config, so every adapter shares one fleet definition.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A process-env-like bag; injected so callers (and tests) never touch globals. */
export type EnvLike = Record<string, string | undefined>;

/** One routable model. `id` is the "provider/model" string. */
export interface FleetEntry {
  readonly id: string;
  readonly description: string;
  /** Free-form labels; passed through verbatim into route option descriptions. */
  readonly tags?: readonly string[];
}

export interface CodriverConfig {
  readonly fleet: readonly FleetEntry[];
  /** Default "provider/model" used when routing does not commit to a fleet entry. */
  readonly fallback?: string;
  /** Minimum Jev confidence for a routed choice. Loader default 0.55. */
  readonly route_threshold?: number;
  /** Jev request timeout in ms. Loader default 1500. */
  readonly route_timeout_ms?: number;
  /** Where the JSONL decision log is written, if set. */
  readonly log_path?: string;
}

export const DEFAULT_ROUTE_THRESHOLD = 0.55;
export const DEFAULT_ROUTE_TIMEOUT_MS = 1500;

/** Typed config failure with a field-level message, thrown at load time only. */
export class ConfigError extends Error {
  /** Dotted path of the offending field, e.g. `fleet[0].id`. */
  readonly field?: string;

  constructor(message: string, options?: { readonly field?: string; readonly cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "ConfigError";
    this.field = options?.field;
  }
}

/** Jev client selection from env: "fixture" forces the deterministic fixture client. */
export type JevMode = "fixture" | "http";

export function jevMode(env: EnvLike): JevMode {
  return env.CODRIVER_JEV === "fixture" ? "fixture" : "http";
}

/**
 * Load the config fresh from disk — every call re-reads the file, so a
 * per-turn caller always sees the current config, never a cached one.
 *
 * No-fleet equivalence (relied on by the config-hook gate): a missing file,
 * an unreadable file, or a file that is not valid JSON all return
 * `{ fleet: [] }` with defaults applied — "no fleet configured", never a
 * crash. A file that IS valid JSON but violates the schema throws
 * ConfigError with a field-level message at load time; the adapter's
 * never-throw catches it and treats it the same way.
 */
export function loadConfig(env: EnvLike): CodriverConfig {
  const path = configPath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return noFleetConfig();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return noFleetConfig();
  }
  return parseConfig(raw);
}

function configPath(env: EnvLike): string {
  const override = env.CODRIVER_CONFIG;
  if (override !== undefined && override !== "") return override;
  // env.HOME first (Bun resolves os.homedir() at startup, ignoring later env); homedir() covers a missing HOME.
  return join(env.HOME ?? homedir(), ".config", "codriver", "config.json");
}

function noFleetConfig(): CodriverConfig {
  return {
    fleet: [],
    route_threshold: DEFAULT_ROUTE_THRESHOLD,
    route_timeout_ms: DEFAULT_ROUTE_TIMEOUT_MS,
  };
}

function parseConfig(raw: unknown): CodriverConfig {
  if (!isRecord(raw)) {
    throw new ConfigError("config file is not a JSON object");
  }
  const { fleet, fallback, route_threshold, route_timeout_ms, log_path } = raw;
  return {
    fleet: parseFleet(fleet),
    fallback: optionalString(fallback, "fallback"),
    route_threshold: optionalNumber(route_threshold, "route_threshold") ?? DEFAULT_ROUTE_THRESHOLD,
    route_timeout_ms: optionalNumber(route_timeout_ms, "route_timeout_ms") ?? DEFAULT_ROUTE_TIMEOUT_MS,
    log_path: optionalString(log_path, "log_path"),
  };
}

function parseFleet(raw: unknown): readonly FleetEntry[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError("config field `fleet` is missing or not an array", { field: "fleet" });
  }
  return raw.map((entry, index) => parseFleetEntry(entry, index));
}

function parseFleetEntry(raw: unknown, index: number): FleetEntry {
  if (!isRecord(raw)) {
    throw new ConfigError(`config field \`fleet[${index}]\` is not an object`, { field: `fleet[${index}]` });
  }
  const { id, description, tags } = raw;
  const base = {
    id: expectString(id, `fleet[${index}].id`),
    description: expectString(description, `fleet[${index}].description`),
  };
  if (tags === undefined) return base;
  if (!isStringArray(tags)) {
    throw new ConfigError(`config field \`fleet[${index}].tags\` is not an array of strings`, {
      field: `fleet[${index}].tags`,
    });
  }
  return { ...base, tags };
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(`config field \`${field}\` is missing or not a string`, { field });
  }
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new ConfigError(`config field \`${field}\` is missing or not a number`, { field });
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : expectString(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : expectNumber(value, field);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
