import { expect, test } from "bun:test";
import { CODE_LANGUAGES_CAP, MESSAGE_PREVIEW_CAP, buildRoutingState } from "../src/state/index.js";
import type { FleetSummary } from "../src/state/index.js";

const fleet: readonly FleetSummary[] = [
  { id: "anthropic/claude-opus", description: "deep reasoning" },
  { id: "openai/gpt-5.5", description: "fast coding", tags: ["cheap"] },
];

test("a 68KB message is hard-capped to a 512-char preview with the exact full char count", () => {
  const text = "x".repeat(68 * 1024);
  const state = buildRoutingState({ agent: "build", text, catalog: fleet });
  console.log(
    `68KB cap: messagePreview.length=${state.messagePreview.length} (cap ${MESSAGE_PREVIEW_CAP}), messageChars=${state.messageChars}`,
  );
  expect(MESSAGE_PREVIEW_CAP).toBe(512);
  expect(state.messagePreview.length).toBe(512);
  expect(state.messagePreview).toBe(text.slice(0, 512));
  expect(state.messageChars).toBe(69632);
});

test("a 600-char message truncates to exactly 512 chars", () => {
  const text = "y".repeat(600);
  const state = buildRoutingState({ agent: "build", text, catalog: [] });
  console.log(`600-char truncation: messagePreview.length=${state.messagePreview.length}`);
  expect(state.messagePreview.length).toBe(512);
  expect(state.messageChars).toBe(600);
});

test("the preview never contains text beyond the cap", () => {
  const text = `${"a".repeat(512)}SECRET-BEYOND-CAP`;
  const state = buildRoutingState({ agent: "build", text, catalog: [] });
  expect(state.messagePreview).not.toContain("SECRET-BEYOND-CAP");
  expect(state.messageChars).toBe(529);
});

test("a short message passes through whole", () => {
  const text = "refactor the auth module";
  const state = buildRoutingState({ agent: "build", text, catalog: [] });
  expect(state.messagePreview).toBe(text);
  expect(state.messageChars).toBe(text.length);
});

test("20 fenced code blocks yield hasCodeBlocks true and at most 5 language names", () => {
  const text = Array.from({ length: 20 }, (_, i) => `\`\`\`lang${i}\ncode\n\`\`\``).join("\n");
  const state = buildRoutingState({ agent: "build", text, catalog: [] });
  console.log(`20-fence scan: codeLanguages=${JSON.stringify(state.codeLanguages)}`);
  expect(CODE_LANGUAGES_CAP).toBe(5);
  expect(state.hasCodeBlocks).toBe(true);
  expect(state.codeLanguages.length).toBe(5);
  expect(state.codeLanguages).toEqual(["lang0", "lang1", "lang2", "lang3", "lang4"]);
});

test("repeated fence languages dedupe into one entry", () => {
  const text = "```python\ncode\n```\n\n```python\nmore\n```";
  const state = buildRoutingState({ agent: "build", text, catalog: [] });
  expect(state.codeLanguages).toEqual(["python"]);
});

test("a bare fence sets hasCodeBlocks without a language entry", () => {
  const state = buildRoutingState({ agent: "build", text: "```\ncode\n```", catalog: [] });
  expect(state.hasCodeBlocks).toBe(true);
  expect(state.codeLanguages).toEqual([]);
});

test("plain prose has no code blocks and no languages", () => {
  const state = buildRoutingState({ agent: "build", text: "explain the routing policy", catalog: [] });
  expect(state.hasCodeBlocks).toBe(false);
  expect(state.codeLanguages).toEqual([]);
});

test("code content never enters codeLanguages — only language names", () => {
  const state = buildRoutingState({ agent: "build", text: "```python\nSECRETCODEBODY\n```", catalog: [] });
  expect(state.codeLanguages).toEqual(["python"]);
  expect(state.codeLanguages.join(",")).not.toContain("SECRETCODEBODY");
});

test("agent, mode, and the catalog fleet pass through into the state", () => {
  const state = buildRoutingState({ agent: "build", mode: "primary", text: "hi", catalog: fleet });
  expect(state.agent).toBe("build");
  expect(state.mode).toBe("primary");
  expect(state.fleet).toEqual(fleet);
});

test("mode is absent when not provided", () => {
  const state = buildRoutingState({ agent: "plan", text: "hi", catalog: [] });
  expect(state.mode).toBeUndefined();
});
