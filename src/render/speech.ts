import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-web";
import { AppError } from "../core/domain";
import { config } from "../server/config";
import { runTool } from "../server/media-tools";

export type Interval = { start: number; end: number };
export const WAVEFORM = Symbol("private analysis waveform");
export const ANALYSIS_REVISION = "2026-11-16-quiet-speech-1";
export const duration = (range: Interval) => range.end - range.start;
export function overlap(a: Interval, b: Interval) { return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)); }
export function complement(ranges: Interval[], total: number) {
  const result: Interval[] = []; let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) { if (range.start > cursor) result.push({ start: cursor, end: range.start }); cursor = Math.max(cursor, range.end); }
  if (cursor < total) result.push({ start: cursor, end: total });
  return result;
}
export function mergeIntervals(ranges: Interval[], gap = 0) {
  const result: Interval[] = [];
  for (const range of [...ranges].filter(p => p.end > p.start).sort((a, b) => a.start - b.start)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end + gap + 1e-9) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
export function subtractIntervals(ranges: Interval[], blockers: Interval[]) {
  const blocked = mergeIntervals(blockers), result: Interval[] = [];
  for (const range of ranges) {
    let cursor = range.start;
    for (const block of blocked) {
      if (block.end <= cursor) continue;
      if (block.start >= range.end) break;
      if (block.start > cursor) result.push({ start: cursor, end: Math.min(block.start, range.end) });
      cursor = Math.max(cursor, block.end); if (cursor >= range.end) break;
    }
    if (cursor < range.end) result.push({ start: cursor, end: range.end });
  }
  return result;
}
export function parseSilence(log: string, total: number) {
  const ranges: Interval[] = []; let start: number | null = null;
  for (const match of log.matchAll(/silence_(start|end):\s*([\d.e+-]+)/g)) {
    const time = Math.max(0, Math.min(total, Number(match[2])));
    if (match[1] === "start") start = time;
    else if (start !== null && time > start) { ranges.push({ start, end: time }); start = null; }
  }
  if (start !== null && total > start) ranges.push({ start, end: total });
  return ranges;
}
export function confirmedPauses(raw: Interval[], denoised: Interval[], vadSpeech: Interval[], weakQuiet: Interval[] = []) {
  // A ratio may confirm quiet but cannot locate a cut. Subtract every supported
  // speech portion first; only the remaining continuous >300 ms is a pause.
  const primary = subtractIntervals(raw.filter(p => duration(p) > 0.300000001), vadSpeech).filter(p => duration(p) > 0.300000001);
  const candidates = denoised.filter(p => duration(p) > 0.300000001
    && !raw.some(r => overlap(r, p) > 0)); // Never enlarge a raw interval under 300 ms.
  const fallback = subtractIntervals(candidates, vadSpeech).filter(p => duration(p) > 0.300000001
    && weakQuiet.reduce((n, r) => n + overlap(r, p), 0) / duration(p) >= 0.25);
  // Fallback deliberately remains conservative when raw energy has no support.
  return [...primary, ...fallback].sort((a, b) => a.start - b.start);
}
export function quietSpeechSupport(samples: Float32Array, total: number, references: Interval[], noiseFloorDb?: number) {
  const frames: { start: number; end: number; db: number }[] = [];
  for (let offset = 0; offset < samples.length; offset += 160) {
    const window = samples.subarray(offset, offset + 160); let power = 0;
    for (const sample of window) power += sample * sample;
    frames.push({ start: offset / 16000, end: Math.min(total, (offset + window.length) / 16000), db: 10 * Math.log10(power / Math.max(1, window.length) + 1e-15) });
  }
  const sorted = frames.map(f => f.db).sort((a, b) => a - b);
  const floor = noiseFloorDb ?? sorted[Math.floor((sorted.length - 1) * .1)] ?? -60;
  const threshold = Math.max(-60, floor + 8), hints = mergeIntervals(references);
  const activity: Interval[] = []; let hintIndex = 0;
  for (const frame of frames) {
    while (hintIndex < hints.length && hints[hintIndex].end <= frame.start) hintIndex++;
    if (frame.db < threshold || hintIndex >= hints.length) continue;
    for (let i = hintIndex; i < hints.length && hints[i].start < frame.end; i++) {
      const start = Math.max(frame.start, hints[i].start), end = Math.min(frame.end, hints[i].end);
      if (end > start) activity.push({ start, end });
    }
  }
  // These intervals are supported by measured energy AND speech/text context.
  // A stretched ASR interval alone never becomes protected speech.
  return { activity: mergeIntervals(activity), noiseFloorDb: floor, softThresholdDb: threshold };
}
export async function createVad() {
  if (!config().vadModelPath) throw new AppError("VAD_NOT_CONFIGURED", "Модель анализа речи ещё не установлена.", 503);
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(await readFile(config().vadModelPath), { executionProviders: ["wasm"] });
  if (!["input", "state", "sr"].every(n => session.inputNames.includes(n))) throw new Error("Unsupported Silero model interface");
  let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]);
  let context = new Float32Array(64);
  return {
    async frame(samples: Float32Array) {
      if (samples.length !== 512) throw new Error("Silero v5 requires exactly 512 samples at 16 kHz");
      const input = new Float32Array(576); input.set(context); input.set(samples, 64);
      const result = await session.run({ input: new ort.Tensor("float32", input, [1, 576]), state,
        sr: new ort.Tensor("int64", BigInt64Array.from([16000n]), []) });
      const probability = Number(result.output.data[0]);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1 || !result.stateN) throw new Error("Invalid Silero inference output");
      state = result.stateN; context = samples.slice(-64);
      return probability;
    },
    release: () => session.release()
  };
}
export async function analyzeSpeech(path: string, total: number, signal: AbortSignal, options: { wordHints?: Interval[]; noiseFloorDb?: number } = {}) {
  const [energy, cleaned, pcm] = await Promise.all([
    runTool(config().ffmpeg, ["-hide_banner", "-i", path, "-vn", "-af", "silencedetect=noise=-35dB:d=0.03", "-f", "null", "-"], signal),
    runTool(config().ffmpeg, ["-hide_banner", "-i", path, "-vn", "-af", "afftdn=nf=-25,silencedetect=noise=-32dB:d=0.08", "-f", "null", "-"], signal),
    runTool(config().ffmpeg, ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], signal, 64 * 1024 * 1024)
  ]);
  const samples = new Float32Array(pcm.stdout.buffer.slice(pcm.stdout.byteOffset, pcm.stdout.byteOffset + pcm.stdout.byteLength));
  const vad = await createVad(); const speech: Interval[] = []; let start: number | null = null, quietAt: number | null = null;
  try {
    for (let offset = 0; offset < samples.length; offset += 512) {
      signal.throwIfAborted();
      const frame = new Float32Array(512); frame.set(samples.subarray(offset, offset + 512));
      const p = await vad.frame(frame), t = offset / 16000;
      if (p >= 0.5) { if (start === null) start = t; quietAt = null; }
      else if (p < 0.35 && start !== null) { quietAt ??= t; if (t - quietAt >= 0.064) { speech.push({ start, end: quietAt }); start = null; quietAt = null; } }
    }
    if (start !== null) speech.push({ start, end: total });
  } finally { await vad.release(); }
  const rawSilence = parseSilence(energy.stderr, total), denoised = parseSilence(cleaned.stderr, total);
  const weakQuiet: Interval[] = []; let weakStart: number | null = null;
  for (let offset = 0; offset < samples.length; offset += 160) {
    const window = samples.subarray(offset, offset + 160); let power = 0; for (const sample of window) power += sample * sample;
    const quiet = 10 * Math.log10(power / Math.max(1, window.length) + 1e-15) < -28;
    if (quiet) weakStart ??= offset / 16000;
    else if (weakStart !== null) { weakQuiet.push({ start: weakStart, end: offset / 16000 }); weakStart = null; }
  }
  if (weakStart !== null) weakQuiet.push({ start: weakStart, end: total });
  const soft = quietSpeechSupport(samples, total, [...speech, ...(options.wordHints || [])], options.noiseFloorDb);
  const supportedSpeech = mergeIntervals([...speech, ...soft.activity]);
  return { analysisRevision: ANALYSIS_REVISION, rawSilence, speech, softSpeech: soft.activity, noiseFloorDb: soft.noiseFloorDb, softThresholdDb: soft.softThresholdDb,
    pauses: confirmedPauses(rawSilence, denoised, supportedSpeech, weakQuiet), active: mergeIntervals([...complement(rawSilence, total), ...soft.activity]), [WAVEFORM]: samples };
}
