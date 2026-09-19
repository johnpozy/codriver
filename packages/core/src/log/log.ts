/**
 * JSONL decision logger with secret sanitization.
 *
 * Appends exactly one JSON line per routing decision (decision volume is
 * ~1/turn, so a plain sync append is the whole story: no rotation, no
 * file locking, no async queue). The logger is fire-and-forget by
 * contract: any filesystem error skips the write silently — logging must
 * never break routing (never-throw invariant D7).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Marker substituted for every occurrence of the API key in logged strings. */
const REDACTED = "[REDACTED]";

/** Cap on the logged state preview — keeps each JSONL line bounded. */
const STATE_PREVIEW_MAX_CHARS = 128;

/**
 * Structural input for the decision logger.
 *
 * Deliberately declared here instead of importing the policy engine's
 * `RoutingDecision`: this package compiles in parallel with it, and any
 * decision object with these fields is structurally assignable.
 */
export interface DecisionLogInput {
  readonly reason: string;
  readonly usedFallback: boolean;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly jevModel: string;
  readonly latencyMs: number;
  readonly stateDigest: { readonly messagePreview: string };
}

/** Per-turn logging metadata: which agent routed, where to log. */
export interface DecisionLogMeta {
  readonly agent: string;
  readonly config: { readonly log_path?: string };
}

/** The exact JSON line shape written to decisions.jsonl. */
interface DecisionLogLine {
  readonly ts: string;
  readonly agent: string;
  readonly reason: string;
  readonly usedFallback: boolean;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly jevModel: string;
  readonly latencyMs: number;
  readonly statePreview: string;
}

/**
 * Append one sanitized JSON line describing a routing decision.
 *
 * Target: `config.log_path` if set, else
 * `${XDG_DATA_HOME ?? ~/.local/share}/codriver/decisions.jsonl`
 * (parent directories created recursively). The API key is read from
 * `process.env.TYPESAFE_API_KEY` at write time; every exact occurrence
 * in any string — values AND object keys such as probability entries —
 * is replaced with "[REDACTED]" before serialization. On any filesystem
 * error the write is skipped silently; the return value is always
 * `undefined`.
 */
export function logDecision(decision: DecisionLogInput, meta: DecisionLogMeta): void {
  const line: DecisionLogLine = {
    ts: new Date().toISOString(),
    agent: meta.agent,
    reason: decision.reason,
    usedFallback: decision.usedFallback,
    model: { providerID: decision.model.providerID, modelID: decision.model.modelID },
    confidence: decision.confidence,
    probabilities: decision.probabilities,
    jevModel: decision.jevModel,
    latencyMs: decision.latencyMs,
    statePreview: decision.stateDigest.messagePreview.slice(0, STATE_PREVIEW_MAX_CHARS),
  };
  const secret = process.env.TYPESAFE_API_KEY;
  const sanitized: unknown = secret !== undefined && secret !== "" ? redactSecrets(line, secret) : line;
  try {
    const logPath = resolveLogPath(meta.config);
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(sanitized)}\n`, "utf8");
  } catch {
    // Spec: any filesystem error skips the write silently — the logger
    // must never break routing.
  }
}

function resolveLogPath(config: DecisionLogMeta["config"]): string {
  if (config.log_path) {
    return config.log_path;
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "codriver", "decisions.jsonl");
}

/**
 * Deep-copy `value` with every exact occurrence of `secret` replaced by
 * "[REDACTED]" in strings AND object keys (probability entries carry
 * model ids in their keys). Builds new objects, so the caller's decision
 * is never mutated.
 */
function redactSecrets(value: unknown, secret: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(secret, REDACTED);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key.replaceAll(secret, REDACTED)] = redactSecrets(entry, secret);
    }
    return out;
  }
  return value;
}
