/**
 * End-to-end pipeline proof for the codriver opencode adapter: the REAL
 * opencode binary + the BUILT adapter plugin + local mock servers, with
 * ZERO paid calls (asserted: "api.typesafe.ai" appears in no evidence
 * file; all LLM and decision traffic lands on 127.0.0.1).
 *
 * Three cases, each spawning `opencode run --print-logs --model
 * codriver/auto "hi"` from an isolated per-case tmp project dir with the
 * XDG_* homes redirected per child process (real HOME retained):
 *
 *  (a) fixture-happy — CODRIVER_JEV=fixture, template scenario:
 *      decision line reason "jev-choice", model mockllm/mock-model.
 *  (b) fixture-timeout — CODRIVER_JEV=fixture + CODRIVER_JEV_SCENARIO=
 *      timeout: the run STILL completes on the fallback (the never-block
 *      promise at whole-system level), with the decision line carrying
 *      reason "timeout" (the wired plugin's bare FixtureJevClient
 *      recognizes the standard scenario names, so route() maps the
 *      JevError("timeout") to reason "timeout").
 *
 *  (c) http-mode — CODRIVER_JEV=http + TYPESAFE_API_URL=<mockjev> +
 *      TYPESAFE_API_KEY=codriver-test-dummy (a DUMMY value, REQUIRED so
 *      the client-selection gate — fixture when CODRIVER_JEV ===
 *      "fixture" or no TYPESAFE_API_KEY — selects the HttpJevClient
 *      instead of silently falling back to the fixture client; it is
 *      never a real credential and mockjev ignores the Bearer value
 *      entirely): proves the real HttpJevClient wiring end-to-end —
 *      reason "jev-choice" AND mockjev's request log shows the
 *      Bearer-authenticated POST with model "jev-1.13.0" in the body.
 *
 * Isolation: all evidence (decisions.jsonl, opencode.db session files)
 * must land under the per-case tmp (XDG overrides). The afterAll audit
 * checks the real ~/.local/share/opencode with a pre-run snapshot + a
 * marker file + `find -newer`; if the binary ignored the overrides, the
 * audit records it and removes EXACTLY the entries this test created —
 * pre-existing content is never deleted or mutated.
 *
 * Skips gracefully (printed reason) when the opencode binary is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockjev, type MockjevServer } from "../../../../tests/infra/mockjev.js";
import { startMockllm } from "../../../../tests/infra/mockllm.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const INFRA_DIR = join(REPO_ROOT, "tests", "infra");
const OPENCODE_BIN = "/home/johnp/.opencode/bin/opencode";
const REAL_OPENDATA = join(homedir(), ".local", "share", "opencode");
/** DUMMY key for the http-mode case ONLY — never a real credential. */
const DUMMY_KEY = "codriver-test-dummy";
/** Per-case opencode run timeout; the per-test timeout is 60000ms. */
const RUN_TIMEOUT_MS = 50_000;

const binaryPresent = existsSync(OPENCODE_BIN);
if (!binaryPresent) {
  console.log(
    `[pipeline] SKIP REASON: opencode binary not found at ${OPENCODE_BIN} — end-to-end cases skipped`,
  );
}
const suite = binaryPresent ? describe : describe.skip;

/** Extra child env for a case, given the chosen mock server ports. */
type CaseEnvBuilder = (ports: {
  readonly mockllm: number;
  readonly mockjev: number;
}) => Record<string, string>;

interface PipelineRun {
  readonly name: string;
  readonly tmp: string;
  /** The exact env map the opencode child was spawned with. */
  readonly env: Record<string, string>;
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly decisionLines: readonly Record<string, unknown>[];
  readonly mockllmRequests: number;
  readonly mockjev: MockjevServer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDecisionLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const lines: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const parsed: Record<string, unknown> = JSON.parse(line);
    lines.push(parsed);
  }
  return lines;
}

function lastDecision(run: PipelineRun): Record<string, unknown> {
  const last = run.decisionLines.at(-1);
  if (last === undefined) {
    throw new Error(`case ${run.name}: no decision line found in decisions.jsonl`);
  }
  return last;
}

function collectFilesUnder(root: string, out: string[]): void {
  const stack: string[] = [root];
  for (;;) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else out.push(path);
    }
  }
}

suite("opencode end-to-end pipeline (real binary, local mocks, zero paid calls)", () => {
  let sharedTmp: string;
  let markerPath: string;
  let realDataExisted: boolean;
  let preExistingEntries: string[];
  const caseTmps: string[] = [];
  const transcripts: { name: string; stdout: string; stderr: string }[] = [];
  let mockjevLog = "";

  beforeAll(() => {
    sharedTmp = mkdtempSync(join(tmpdir(), "codriver-pipeline-shared-"));

    // Isolation pre-run state: snapshot the real opencode data dir, then
    // drop the marker every `find -newer` compares against.
    realDataExisted = existsSync(REAL_OPENDATA);
    preExistingEntries = realDataExisted ? readdirSync(REAL_OPENDATA) : [];
    markerPath = join(sharedTmp, "isolation-marker");
    writeFileSync(markerPath, "");

    // Build the adapter ONCE before the cases — the file: plugin loads
    // compiled JS (dist/index.js). `nx run opencode:build` builds the
    // core dependency first (targetDefaults dependsOn ^build).
    const build = spawnSync("npx", ["nx", "run", "opencode:build"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    console.log(`[pipeline] adapter build (npx nx run opencode:build): exit=${build.status}`);
    if (build.status !== 0) {
      console.log(`[pipeline] build stdout:\n${build.stdout ?? ""}`);
      console.log(`[pipeline] build stderr:\n${build.stderr ?? ""}`);
    }
    expect(build.status).toBe(0);
    expect(existsSync(join(REPO_ROOT, "packages", "opencode", "dist", "index.js"))).toBe(true);
  }, 240_000);

/** One opencode run: async spawn so the event loop (and the in-process mock servers) stays alive. */
interface OpencodeRunResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn the opencode binary and await completion. Bun.spawn (async), NOT
 * spawnSync: a synchronous spawn blocks the bun event loop, and the
 * in-process Bun.serve mocks could then never accept the child's LLM
 * requests — the run deadlocks (verified empirically: 0 mockllm requests,
 * SIGTERM at the timeout). Streams are consumed concurrently with the
 * exit wait so a chatty child can never fill the pipe buffer.
 */
async function spawnOpencodeRun(tmp: string, env: Record<string, string>): Promise<OpencodeRunResult> {
  const proc = Bun.spawn({
    cmd: [OPENCODE_BIN, "run", "--print-logs", "--model", "codriver/auto", "hi"],
    cwd: tmp,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const outcome = await Promise.race([
    proc.exited.then((code) => ({ code, timedOut: false })),
    Bun.sleep(RUN_TIMEOUT_MS).then(() => ({ code: null, timedOut: true })),
  ]);
  if (outcome.timedOut) proc.kill();
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  return {
    status: outcome.timedOut ? null : outcome.code,
    signal: outcome.timedOut ? "SIGTERM" : null,
    stdout,
    stderr,
  };
}

/**
 * Run one pipeline case: fresh tmp project, in-process mock servers,
 * materialized configs, spawned opencode, evidence logged. Servers are
 * stopped before returning; their request logs stay readable.
 */
async function runPipeline(name: string, caseEnv: CaseEnvBuilder): Promise<PipelineRun> {
    const tmp = mkdtempSync(join(tmpdir(), `codriver-pipeline-${name}-`));
    caseTmps.push(tmp);
    const mockllm = startMockllm();
    const mockjev = startMockjev();

    // Scratch project config (opencode reads project config from cwd):
    // file: plugin pointing at the BUILT adapter entry + the mockllm
    // provider with the real spawned port.
    const opencodeJson = readFileSync(join(INFRA_DIR, "opencode.json"), "utf8")
      .replaceAll("{{REPO_ROOT}}", REPO_ROOT)
      .replaceAll("{{MOCKLLM_PORT}}", String(mockllm.port));
    JSON.parse(opencodeJson); // template sanity — throws on a malformed fixture
    writeFileSync(join(tmp, "opencode.json"), opencodeJson);

    // The codriver fleet config: fixture fleet + fallback + log_path.
    const decisionsPath = join(tmp, "decisions.jsonl");
    const codriverConfig = readFileSync(join(INFRA_DIR, "codriver.config.json"), "utf8").replaceAll(
      "{{LOG_PATH}}",
      decisionsPath,
    );
    JSON.parse(codriverConfig);
    writeFileSync(join(tmp, "codriver.config.json"), codriverConfig);

    // Child env: inherit the ambient env, scrub every codriver/typesafe
    // variable (no real TYPESAFE_API_KEY may ever reach a case), then
    // apply the XDG isolation overrides and the case-specific values.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.TYPESAFE_API_KEY;
    delete env.TYPESAFE_API_URL;
    delete env.CODRIVER_JEV;
    delete env.CODRIVER_JEV_SCENARIO;
    delete env.CODRIVER_CONFIG;
    env.XDG_DATA_HOME = tmp;
    env.XDG_CONFIG_HOME = tmp;
    env.XDG_STATE_HOME = tmp;
    env.XDG_CACHE_HOME = join(sharedTmp, "cache");
    env.CODRIVER_CONFIG = join(tmp, "codriver.config.json");
    // `opencode run` resolves its directory as resolve(env.PWD ?? cwd) —
    // an inherited PWD pointing elsewhere makes the run land in a second
    // instance for THAT directory (no tmp project config → Model not
    // found). Align PWD with the child cwd (verified v1.18.31).
    env.PWD = tmp;
    Object.assign(env, caseEnv({ mockllm: mockllm.port, mockjev: mockjev.port }));

    const run = await spawnOpencodeRun(tmp, env);
    const stdout = run.stdout;
    const stderr = run.stderr;
    transcripts.push({ name, stdout, stderr });
    const decisionLines = readDecisionLines(decisionsPath);
    mockjevLog += JSON.stringify(mockjev.requests);

    console.log(`\n===== [pipeline:${name}] =====`);
    console.log(
      `[pipeline:${name}] tmp=${tmp} mockllm=127.0.0.1:${mockllm.port} mockjev=127.0.0.1:${mockjev.port}`,
    );
    console.log(
      `[pipeline:${name}] child env: CODRIVER_JEV=${env.CODRIVER_JEV ?? "(unset)"} ` +
        `CODRIVER_JEV_SCENARIO=${env.CODRIVER_JEV_SCENARIO ?? "(unset)"} ` +
        `TYPESAFE_API_URL=${env.TYPESAFE_API_URL ?? "(unset)"} ` +
        `TYPESAFE_API_KEY=${env.TYPESAFE_API_KEY === undefined ? "(unset)" : "(dummy set)"}`,
    );
    console.log(
      `[pipeline:${name}] opencode exit=${run.status} signal=${run.signal ?? "-"} ` +
        `mockllmRequests=${mockllm.requests.length} mockjevRequests=${mockjev.requests.length}`,
    );
    console.log(`[pipeline:${name}] stdout: ${JSON.stringify(stdout)}`);
    console.log(`[pipeline:${name}] stderr:\n${stderr}`);
    console.log(
      `[pipeline:${name}] decisions.jsonl (${decisionLines.length} line(s)):\n` +
        decisionLines.map((line) => JSON.stringify(line)).join("\n"),
    );
    if (mockjev.requests.length > 0) {
      console.log(
        `[pipeline:${name}] mockjev request log:\n${JSON.stringify(mockjev.requests, null, 2)}`,
      );
    }

    mockllm.stop();
    mockjev.stop();
    return {
      name,
      tmp,
      env,
      status: run.status,
      signal: run.signal,
      stdout,
      stderr,
      decisionLines,
      mockllmRequests: mockllm.requests.length,
      mockjev,
    };
  }

  test(
    "(a) fixture-mode happy path: jev-choice routes the turn to mockllm",
    async () => {
      const run = await runPipeline("fixture-happy", () => ({ CODRIVER_JEV: "fixture" }));

      // No fixture-mode bypass: assert the env this case ran under.
      expect(run.env.CODRIVER_JEV).toBe("fixture");
      expect(run.env.CODRIVER_JEV_SCENARIO).toBeUndefined();
      expect(run.env.TYPESAFE_API_KEY).toBeUndefined();
      expect(run.env.TYPESAFE_API_URL).toBeUndefined();

      // Full-pipeline success: run completes, assistant output renders.
      expect(run.status).toBe(0);
      expect(run.stdout.trim().length).toBeGreaterThan(0);
      expect(run.stdout).toContain("ok");

      // Evidence under the per-case tmp (XDG overrides honored).
      expect(existsSync(join(run.tmp, "opencode", "opencode.db"))).toBe(true);

      // The decision line: fixture template picks the first fleet entry.
      expect(run.decisionLines.length).toBeGreaterThan(0);
      expect(lastDecision(run)).toMatchObject({
        reason: "jev-choice",
        usedFallback: false,
        model: { providerID: "mockllm", modelID: "mock-model" },
        confidence: 0.9,
      });
      expect(lastDecision(run).probabilities).toMatchObject({ "mockllm/mock-model": 0.9 });

      // The rewrite drove the session loop: traffic hit mockllm.
      expect(run.mockllmRequests).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  test(
    "(b) fixture-mode timeout scenario: run still completes on the fallback (never-block)",
    async () => {
      const run = await runPipeline("fixture-timeout", () => ({
        CODRIVER_JEV: "fixture",
        CODRIVER_JEV_SCENARIO: "timeout",
      }));

      // No fixture-mode bypass: assert the env this case ran under.
      expect(run.env.CODRIVER_JEV).toBe("fixture");
      expect(run.env.CODRIVER_JEV_SCENARIO).toBe("timeout");
      expect(run.env.TYPESAFE_API_KEY).toBeUndefined();
      expect(run.env.TYPESAFE_API_URL).toBeUndefined();

      // The never-block promise at whole-system level: the run STILL
      // completes and the assistant output renders.
      expect(run.status).toBe(0);
      expect(run.stdout.trim().length).toBeGreaterThan(0);
      expect(run.stdout).toContain("ok");
      expect(existsSync(join(run.tmp, "opencode", "opencode.db"))).toBe(true);

      // The decision line: fallback used, fallback model. The wired
      // plugin's bare FixtureJevClient recognizes the standard "timeout"
      // scenario name, so route() maps the JevError("timeout") to
      // reason "timeout".
      expect(run.decisionLines.length).toBeGreaterThan(0);
      expect(lastDecision(run)).toMatchObject({
        reason: "timeout",
        usedFallback: true,
        model: { providerID: "mockllm", modelID: "mock-model" },
      });

      // The fallback model still served the turn.
      expect(run.mockllmRequests).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  test(
    "(c) http-mode: the real HttpJevClient wiring against mockjev",
    async () => {
      const run = await runPipeline("http-mode", (ports) => ({
        CODRIVER_JEV: "http",
        TYPESAFE_API_URL: `http://127.0.0.1:${ports.mockjev}/v1`,
        TYPESAFE_API_KEY: DUMMY_KEY,
      }));

      // The client-selection gate flipped to HttpJevClient: http mode +
      // the DUMMY key + the mockjev URL.
      expect(run.env.CODRIVER_JEV).toBe("http");
      expect(run.env.TYPESAFE_API_URL).toBe(`http://127.0.0.1:${run.mockjev.port}/v1`);
      expect(run.env.TYPESAFE_API_KEY).toBe(DUMMY_KEY);

      // Full-pipeline success through the real HTTP client.
      expect(run.status).toBe(0);
      expect(run.stdout.trim().length).toBeGreaterThan(0);
      expect(run.stdout).toContain("ok");
      expect(existsSync(join(run.tmp, "opencode", "opencode.db"))).toBe(true);

      // The decision line: mockjev's canned route answer won.
      expect(run.decisionLines.length).toBeGreaterThan(0);
      expect(lastDecision(run)).toMatchObject({
        reason: "jev-choice",
        usedFallback: false,
        model: { providerID: "mockllm", modelID: "mock-model" },
        confidence: 0.9,
      });

      // The real HttpJevClient request, logged by mockjev: a POST to
      // /v1/systemone, Bearer-authenticated with the DUMMY key, carrying
      // the pinned model and the three-question pack in the body.
      const posts = run.mockjev.requests.filter(
        (entry) => entry.method === "POST" && entry.path === "/v1/systemone",
      );
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const post = posts.at(-1);
      if (post === undefined) throw new Error("no mockjev POST recorded");
      expect(post.authorization).toBe(`Bearer ${DUMMY_KEY}`);
      if (!isRecord(post.body)) throw new Error("mockjev POST body is not a JSON object");
      expect(post.body.model).toBe("jev-1.13.0");
      const questions = post.body.questions;
      if (isRecord(questions)) {
        expect(Object.keys(questions).sort()).toEqual(["complexity", "domain", "route"]);
      }

      // The rewrite drove the session loop: traffic hit mockllm.
      expect(run.mockllmRequests).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  test(
    "no paid surface: api.typesafe.ai appears in no evidence file",
    () => {
      // Every file under every case tmp (decisions.jsonl, opencode logs,
      // session storage) plus the run transcripts and the mockjev log.
      const files: string[] = [];
      for (const tmp of caseTmps) collectFilesUnder(tmp, files);
      const matched: string[] = [];
      for (const path of files) {
        if (readFileSync(path, "utf8").includes("api.typesafe.ai")) matched.push(path);
      }
      for (const transcript of transcripts) {
        if (transcript.stdout.includes("api.typesafe.ai")) {
          matched.push(`${transcript.name} stdout`);
        }
        if (transcript.stderr.includes("api.typesafe.ai")) {
          matched.push(`${transcript.name} stderr`);
        }
      }
      if (mockjevLog.includes("api.typesafe.ai")) matched.push("mockjev request log");

      // The spec-verbatim grep proof for the evidence bundle (exit 1 =
      // no match across all case tmps).
      const grep = spawnSync("grep", ["-rq", "api.typesafe.ai", ...caseTmps], {
        encoding: "utf8",
      });
      console.log(
        `[pipeline] no-paid-surface: grep -rq api.typesafe.ai <case tmps> → exit ${grep.status} ` +
          `(1 = no match); scanned ${files.length} evidence file(s), ` +
          `${transcripts.length} transcript(s), mockjev log`,
      );
      expect(grep.status).toBe(1);
      expect(matched).toEqual([]);
    },
    30_000,
  );

  afterAll(() => {
    // Isolation audit + cleanup — runs even when cases fail. The deletion
    // set is the pre/post top-level snapshot diff (exactly the entries
    // this test created); `find -newer` additionally records anything
    // touched in the window (e.g. this runner's own concurrent opencode
    // session writing tool-output) — touched is NOT deleted.
    if (realDataExisted) {
      const find = spawnSync("find", [REAL_OPENDATA, "-newer", markerPath], {
        encoding: "utf8",
      });
      const touched = find.stdout.split("\n").filter((line) => line.trim() !== "");
      console.log(
        `[pipeline] isolation audit: find ${REAL_OPENDATA} -newer <marker> → ` +
          `${touched.length} touched path(s) (expected noise: concurrent real-session writes)`,
      );
      for (const path of touched) console.log(`[pipeline]   touched: ${path}`);
      const created = readdirSync(REAL_OPENDATA).filter(
        (entry) => !preExistingEntries.includes(entry),
      );
      if (created.length > 0) {
        console.log(
          `[pipeline] isolation DEVIATION: the binary wrote to the real data dir — ` +
            `removing EXACTLY the test-created entries: ${created.join(", ")}`,
        );
        for (const entry of created) {
          rmSync(join(REAL_OPENDATA, entry), { recursive: true, force: true });
        }
        const remaining = readdirSync(REAL_OPENDATA).filter(
          (entry) => !preExistingEntries.includes(entry),
        );
        console.log(
          `[pipeline] cleanup proof: test-created entries remaining after removal: ` +
            `${remaining.length === 0 ? "(none)" : remaining.join(", ")}`,
        );
      } else {
        console.log(
          "[pipeline] isolation: XDG overrides honored — no test-created entries in the real opencode data dir",
        );
      }
    } else if (existsSync(REAL_OPENDATA)) {
      console.log(
        `[pipeline] isolation DEVIATION: ${REAL_OPENDATA} was created during the run — ` +
          `removing it entirely (test-created)`,
      );
      rmSync(REAL_OPENDATA, { recursive: true, force: true });
    } else {
      console.log(
        "[pipeline] isolation: real opencode data dir absent before and after — nothing to audit",
      );
    }

    for (const tmp of caseTmps) rmSync(tmp, { recursive: true, force: true });
    rmSync(sharedTmp, { recursive: true, force: true });
  });
});
