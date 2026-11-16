import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runTool, probe } from "../src/server/media-tools";
import { config } from "../src/server/config";
import { makeCaptions } from "../src/render/captions";
import { renderVideo, ffmpegSeconds } from "../src/render/engine";
import { contentHash } from "../src/core/script-document";
import { streamAsset } from "../src/server/storage";
import { defaultSettings, type Asset } from "../src/core/domain";

test("actual FFmpeg render: hook reorder, deleted word, MP4 decode, QA, subtitles and Range", async () => {
  const root = await mkdtemp(join(tmpdir(), "speechcut-media-")), previousData = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  try {
    await mkdir(join(root, "source"));
    const path = join(root, "source/test.mp4");
    // Known tones and colors are deterministic media fixtures, not a speech/ASR test.
    await runTool(config().ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=360x640:r=30:d=3", "-f", "lavfi", "-i", "aevalsrc=exprs='if(between(t,0.2,0.7),0.15*sin(2*PI*440*t),if(between(t,1.2,1.7),0.15*sin(2*PI*880*t),if(between(t,2.2,2.7),0.15*sin(2*PI*660*t),0)))':s=48000:d=3", "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='between(t,1,2)',drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='between(t,2,3)'", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
    const media = await probe(path), jobId = randomUUID();
    const words = [0, 1, 2].map(i => ({ id: `w${i}`, rawText: ["Первый", "Удалённый", "Хук"][i], startMs: i * 1000 + 200, endMs: i * 1000 + 700, confidence: 1 }));
    const units = [words[2], words[0]].map(w => ({ id: w.id, wordIds: [w.id], text: w.rawText }));
    const source: Asset = { id: randomUUID(), jobId, kind: "source", storageKey: "source/test.mp4", mime: "video/mp4", bytes: (await stat(path)).size, checksum: "fixture", media, createdAt: Date.now() };
    const result = await renderVideo({ source, operationId: randomUUID(), settings: defaultSettings,
      transcript: { id: randomUUID(), jobId, sourceChecksum: "fixture", providerRequestId: "fixture", model: "fixture", rawText: "Первый Удалённый Хук", words, proofreadingStatus: "completed", createdAt: Date.now() },
      version: { id: randomUUID(), jobId, parentId: null, units, request: "fixture", author: "user", contentHash: contentHash(units), createdAt: Date.now() } }, new AbortController().signal, () => {});
    assert.equal(result.qa.wordCount, 2); assert.equal(result.qa.remainingPauses, 0); assert.ok(result.media.duration < 2);
    assert.equal(result.media.width, 360); assert.equal(result.media.height, 640); assert.equal(result.media.sar, "1:1");
    for (const [time, expected] of [[.3, "green"], [1, "red"]] as const) {
      const frame = await runTool(config().ffmpeg, ["-v", "error", "-ss", String(time), "-i", result.outputPath, "-frames:v", "1", "-vf", "crop=2:2:0:0,format=rgb24", "-f", "rawvideo", "-"]);
      const [r, g] = frame.stdout; assert.ok(expected === "green" ? g > r * 1.5 : r > g * 1.5);
    }
    const decoded = await runTool(config().ffmpeg, ["-v", "error", "-i", result.outputPath, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"]);
    const audio = new Float32Array(decoded.stdout.buffer.slice(decoded.stdout.byteOffset, decoded.stdout.byteOffset + decoded.stdout.byteLength));
    const power = (frequency: number) => { let re = 0, im = 0; for (let i = 0; i < audio.length; i++) { re += audio[i] * Math.cos(2 * Math.PI * frequency * i / 8000); im += audio[i] * Math.sin(2 * Math.PI * frequency * i / 8000); } return re * re + im * im; };
    assert.ok(power(880) < Math.max(power(440), power(660)) * .02, "deleted audio tone must be absent");
    const output: Asset = { ...source, id: randomUUID(), storageKey: result.outputPath.slice(root.length + 1), kind: "output", bytes: result.bytes, media: result.media };
    const range = await streamAsset(output, new Request("http://localhost/media/test", { headers: { range: "bytes=0-1023" } }));
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 1024);
    const badRange = await streamAsset(output, new Request("http://localhost/media/test", { headers: { range: "bytes=900000000-" } })); assert.equal(badRange.status, 416);
    const download = await streamAsset(output, new Request("http://localhost/media/test?download=1", { method: "HEAD" }), true);
    assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="video.mp4"');
    assert.equal(download.headers.get("Access-Control-Allow-Origin"), "https://web.telegram.org");
    assert.equal(download.headers.get("Content-Length"), String(result.bytes));
  } finally { if (previousData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousData; await rm(root, { recursive: true, force: true }); }
});
test("subtitle lines fit measured 10% safe margins and font contains Cyrillic", () => {
  const units = [{ id: "w0", wordIds: ["w0"], text: "Образовываться" }, { id: "w1", wordIds: ["w1"], text: "ChatGPT" }];
  const mapped = units.map((u, i) => ({ id: u.id, rawText: u.text, startMs: i * 800, endMs: i * 800 + 700, confidence: 1, acousticStart: i * .8, acousticEnd: i * .8 + .7, outputStart: i * .8, outputEnd: i * .8 + .7 }));
  const result = makeCaptions(units, mapped, 360, 640, 77, config().fontPath);
  assert.ok(result.cues.length > 0); assert.ok(result.cues.every(c => c.lines.length <= 2 && c.measuredWidths.every(w => w <= 288)));
  assert.ok(result.ass.includes("Образовываться"));
});
test("fractional 100 ms boundary residue remains a valid FFmpeg duration", async () => {
  await runTool(config().ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=0.1", "-vf", `tpad=start_duration=${ffmpegSeconds(2.7755575615628914e-17)}`, "-f", "null", "-"]);
});
test("actual libass glyph and outline pixels stay inside 10% side margins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "speechcut-pixels-"));
  try {
    const units = [{ id: "w0", wordIds: ["w0"], text: "Образовываться" }, { id: "w1", wordIds: ["w1"], text: "ChatGPT" }];
    const mapped = units.map((u, i) => ({ id: u.id, rawText: u.text, startMs: i * 800, endMs: i * 800 + 700, confidence: 1, acousticStart: i * .8, acousticEnd: i * .8 + .7, outputStart: i * .8, outputEnd: i * .8 + .7 }));
    const ass = join(dir, "captions.ass"); await writeFile(ass, makeCaptions(units, mapped, 360, 640, 77, config().fontPath).ass);
    const result = await runTool(config().ffmpeg, ["-hide_banner", "-f", "lavfi", "-i", "color=c=gray:s=360x640:r=2:d=2", "-filter_complex", `[0:v]split[base][text];[text]subtitles=filename='${ass}'[captioned];[base][captioned]blend=all_mode=difference,bbox=min_val=8[out]`, "-map", "[out]", "-f", "null", "-"]);
    let checked = 0;
    for (const m of result.stderr.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)) {
      const left = Number(m[1]), right = Number(m[2]); if (right < left) continue; checked++;
      assert.ok(left >= 36 && right <= 323, `libass pixels exceed side margins: ${left}..${right}`);
    }
    assert.ok(checked >= 2, "multiple frames must contain visible captions");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("actual render retains a quiet short word below the old -35 dB gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "speechcut-quiet-")), previousData = process.env.DATA_DIR; process.env.DATA_DIR = root;
  try {
    await mkdir(join(root, "source")); const path = join(root, "source/quiet.mp4");
    await runTool(config().ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x240:r=30:d=2", "-f", "lavfi", "-i", "aevalsrc=exprs='if(between(t,0.2,0.4),0.003*sin(2*PI*420*t),if(between(t,1,1.4),0.15*sin(2*PI*660*t),0))':s=48000:d=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", path]);
    const jobId = randomUUID(), words = [{ id: "w0", rawText: "И", startMs: 200, endMs: 400, confidence: 1 }, { id: "w1", rawText: "речь", startMs: 1000, endMs: 1400, confidence: 1 }];
    const units = words.map(w => ({ id: w.id, wordIds: [w.id], text: w.rawText }));
    const source: Asset = { id: randomUUID(), jobId, kind: "source", storageKey: "source/quiet.mp4", mime: "video/mp4", bytes: (await stat(path)).size, checksum: "quiet-fixture", media: await probe(path), createdAt: Date.now() };
    const result = await renderVideo({ source, operationId: randomUUID(), settings: defaultSettings,
      transcript: { id: randomUUID(), jobId, sourceChecksum: source.checksum, providerRequestId: "fixture", model: "fixture", rawText: "И речь", words, proofreadingStatus: "completed", createdAt: Date.now() },
      version: { id: randomUUID(), jobId, parentId: null, units, request: "quiet synthetic tones", author: "user", contentHash: contentHash(units), createdAt: Date.now() } }, new AbortController().signal, () => {});
    assert.equal(result.qa.wordSignalCheck.verifiedWords, 2); assert.equal(result.qa.remainingPauses, 0);
    assert.ok(result.qa.wordSignalCheck.minCorrelation >= .65); assert.ok(result.qa.duration < 1.5);
  } finally { if (previousData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousData; await rm(root, { recursive: true, force: true }); }
});
