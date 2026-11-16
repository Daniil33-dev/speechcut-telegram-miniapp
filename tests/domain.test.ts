import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyTelegram } from "../src/server/auth";
import { applyProofreading, applySpans, validateManualEdit } from "../src/core/script-document";
import { tokenCost, summarizeUsage } from "../src/core/usage";
import { fitWord, buildEditMap } from "../src/render/edit-map";
import { confirmedPauses, quietSpeechSupport } from "../src/render/speech";
import { verifyWordAudio } from "../src/render/word-audio";
import { defaultSettings, type Word } from "../src/core/domain";
import { proofreadSchema } from "../src/core/proofread-schema";
import { zodTextFormat } from "openai/helpers/zod";

const words: Word[] = ["да", "да", "чад", "джи", "пи", "ти"].map((rawText, i) => ({ id: `w${i}`, rawText, startMs: i * 400, endMs: i * 400 + 300, confidence: .95 }));
const units = words.map(w => ({ id: w.id, wordIds: [w.id], text: w.rawText }));
function signed(now: number, id = 123) {
  const p = new URLSearchParams({ user: JSON.stringify({ id }), auth_date: String(now), query_id: "test" });
  const data = [...p].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update("test-token").digest()).update(data).digest("hex"));
  return p.toString();
}
test("Telegram signature, auth_date and duplicate keys are enforced", () => {
  assert.equal(verifyTelegram(signed(10000), "test-token", 10001), "123");
  assert.throws(() => verifyTelegram(signed(10000), "wrong", 10001));
  assert.throws(() => verifyTelegram(signed(10000), "test-token", 14000));
  assert.throws(() => verifyTelegram(signed(10000) + "&user=%7B%7D", "test-token", 10001));
});
test("repeated identical words retain distinct identities on manual deletion", () => {
  validateManualEdit(units.slice(1), units, words);
  assert.equal(units.slice(1)[0].id, "w1");
  assert.throws(() => validateManualEdit([units[1], units[0]], units, words));
});
test("proofreading groups keep every source word even for a single product name", () => {
  const result = applyProofreading([{ wordIds: ["w0"], text: "Да," }, { wordIds: ["w1"], text: "да." }, { wordIds: ["w2", "w3", "w4", "w5"], text: "ChatGPT" }], words);
  assert.equal(result[2].wordIds.length, 4);
  assert.throws(() => applyProofreading([{ wordIds: ["w2"], text: "ChatGPT" }], words));
  const split = applyProofreading([{ wordIds: words.map(w => w.id), text: "Да, да чад джи пи ти." }], words);
  assert.equal(split.length, words.length);
  validateManualEdit(split.slice(1), split, words);
  assert.equal(split.slice(1)[0].wordIds[0], "w1");
  assert.throws(() => applyProofreading([{ wordIds: words.map(w => w.id), text: "Другая короткая фраза" }], words));
  assert.throws(() => applyProofreading([{ wordIds: ["w1", "w0", "w2", "w3", "w4", "w5"], text: "Да да чад джи пи ти" }], words));
});
test("OpenAI proofreading format rejects whole phrases before they become editable groups", () => {
  assert.equal(proofreadSchema.safeParse({ groups: [{ wordIds: ["w0", "w1"], text: "Да да" }] }).success, false);
  assert.equal(proofreadSchema.safeParse({ groups: [{ wordIds: ["w2", "w3", "w4", "w5"], text: "ChatGPT" }] }).success, true);
  const schema = zodTextFormat(proofreadSchema, "proofread").schema as { properties: { groups: { items: { properties: { text: { pattern: string } } } } } };
  assert.ok(schema.properties.groups.items.properties.text.pattern);
  assert.equal(new RegExp(schema.properties.groups.items.properties.text.pattern).test("обычная фраза"), false);
});
test("hook moves once; duplicate, overlapping and removed words are rejected", () => {
  const result = applySpans([{ fromWord: "w4", toWord: "w5" }, { fromWord: "w0", toWord: "w3" }], units, words);
  assert.equal(result[0].id, "w4");
  assert.throws(() => applySpans([{ fromWord: "w0", toWord: "w2" }, { fromWord: "w2", toWord: "w3" }], units, words));
  assert.throws(() => applySpans([{ fromWord: "w0", toWord: "w2" }], [units[0], units[2]], words));
  assert.throws(() => applySpans([{ fromWord: "foreign", toWord: "w2" }], units, words));
});
test("token cost excludes cached tokens from ordinary input billing; unknown is not free", () => {
  assert.equal(tokenCost(100, 80, 10, { input: 1, cached: .1, output: 2, date: "test" }), .000048);
  assert.equal(tokenCost(100, 80, 10, null), null);
  assert.throws(() => tokenCost(10, 11, 0, { input: 1, cached: 1, output: 1, date: "test" }));
  assert.deepEqual(summarizeUsage([]).hasUsage, false);
});
test("cache writes replace ordinary input billing, with separate retention rates", () => {
  assert.equal(tokenCost(100, 20, 10, { input: 1, cached: .1, output: 2, write30m: 1.25, write12h: 2.5, date: "test" }, 30, 10), .000122);
  assert.equal(tokenCost(100, 20, 10, { input: 1, cached: .1, output: 2, date: "test" }, 30, 10), null);
});
test("299 and 300 ms stay; only a confirmed pause over 300 ms can be cut", () => {
  assert.equal(confirmedPauses([{ start: 0, end: .299 }, { start: 1, end: 1.3 }, { start: 2, end: 2.301 }], [], []).length, 1);
  assert.equal(confirmedPauses([{ start: 0, end: 1 }], [], [{ start: 0, end: 1 }]).length, 0);
});
test("denoised fallback needs VAD plus weak energy and cannot enlarge a short raw pause", () => {
  assert.equal(confirmedPauses([], [{ start: 0, end: 1 }], [], [{ start: 0, end: 1 }]).length, 1);
  assert.equal(confirmedPauses([{ start: .2, end: .499 }], [{ start: 0, end: 1 }], [], [{ start: 0, end: 1 }]).length, 0);
  assert.equal(confirmedPauses([], [{ start: 0, end: 1 }], [], []).length, 0);
});
test("stretched ASR span does not protect one second of leading silence", () => {
  const word = { ...words[0], startMs: 0, endMs: 1200 };
  assert.deepEqual(fitWord(word, [{ start: 1, end: 1.2 }]), { start: 1, end: 1.2 });
  const map = buildEditMap([word], [{ id: "w0", wordIds: ["w0"], text: "Я" }], defaultSettings, 2, [{ start: 1, end: 1.2 }], [{ start: 0, end: 1 }, { start: 1.2, end: 2 }]);
  assert.ok(map.duration < .5);
  assert.ok(map.words[0].outputStart >= .099);
  assert.ok(map.duration - map.words[0].outputEnd >= .099);
});
test("no acoustic evidence for a selected word blocks publication", () => {
  assert.throws(() => fitWord(words[0], []), (error: unknown) => (error as { code: string }).code === "WORD_CHECK_FAILED");
});
test("pause boundaries exclude every speech tail before applying the 300 ms threshold", () => {
  assert.deepEqual(confirmedPauses([{ start: 0, end: .6 }], [], [{ start: 0, end: .2 }]), [{ start: .2, end: .6 }]);
  assert.deepEqual(confirmedPauses([{ start: 0, end: .4 }], [], [{ start: .15, end: .25 }]), []);
  const pause = confirmedPauses([{ start: 6.93525, end: 7.37381 }], [], [{ start: 6.368, end: 7.05 }]);
  assert.deepEqual(pause, [{ start: 7.05, end: 7.37381 }]);
});
test("quiet short words gain measured support, while stretched hints and noise alone do not", () => {
  const samples = Float32Array.from({ length: 16000 }, (_, i) => .0002 * Math.sin(i * .37) + (i >= 6720 && i < 8000 ? .003 * Math.sin(2 * Math.PI * 420 * i / 16000) : 0));
  const result = quietSpeechSupport(samples, 1, [{ start: 0, end: .8 }]);
  const word = { ...words[0], startMs: 0, endMs: 800 };
  const fitted = fitWord(word, result.activity);
  assert.ok(fitted.start >= .41 && fitted.end <= .51);
  assert.ok(result.softThresholdDb < -45);
  const noise = Float32Array.from({ length: 16000 }, (_, i) => .0002 * Math.sin(i * .37));
  assert.deepEqual(quietSpeechSupport(noise, 1, [{ start: 0, end: 1 }]).activity, []);
});
test("post-render word checks compare sound, reject muted words and missing internal speech", async () => {
  const source = Float32Array.from({ length: 24000 }, (_, i) => i >= 3200 && i < 9600 ? .1 * Math.sin(2 * Math.PI * 440 * i / 16000) : 0);
  const word = { ...words[0], startMs: 200, endMs: 600, acousticStart: .2, acousticEnd: .6, outputStart: .1, outputEnd: .5 };
  const range = { start: .1, end: .7, outputStart: 0, outputEnd: .6, padBefore: 0, padAfter: 0 };
  const output = source.slice(1600, 11200), map = { words: [word], ranges: [range] }, evidence = [{ start: .2, end: .6 }], signal = new AbortController().signal;
  assert.equal((await verifyWordAudio(source, output, map, evidence, -60, signal)).passed, true);
  assert.equal((await verifyWordAudio(source, new Float32Array(output.length), map, evidence, -60, signal)).passed, false);
  const missing = { words: [word], ranges: [{ ...range, end: .3 }, { ...range, start: .4 }] };
  assert.equal((await verifyWordAudio(source, output, missing, evidence, -60, signal)).passed, false);
});
