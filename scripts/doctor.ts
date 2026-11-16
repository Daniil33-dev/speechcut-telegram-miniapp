import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openSync, type Font } from "fontkit";
import { config } from "../src/server/config";
import { openDatabase } from "../src/server/db";
import { runTool } from "../src/server/media-tools";
import { createVad } from "../src/render/speech";

const c = config(); let failed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) { try { const result = await fn(); console.log(`PASS ${name}${result ? `: ${result}` : ""}`); } catch { failed++; console.log(`FAIL ${name}`); } }
await check("Node.js 24", () => { if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error(); return process.version; });
await check("SQLite migrations, WAL and transactional read/write", () => { const db = openDatabase(c.dbPath); db.exec("BEGIN IMMEDIATE"); try { db.prepare("INSERT INTO worker_heartbeat VALUES(?,?)").run(`doctor-${randomUUID()}`, Date.now()); if (!db.prepare("SELECT count(*) AS n FROM worker_heartbeat").get()) throw new Error(); } finally { db.exec("ROLLBACK"); db.close(); } });
await check("Private storage read/write", async () => { const dir = join(c.dataDir, "doctor"); await mkdir(dir, { recursive: true, mode: 0o700 }); const path = join(dir, randomUUID()); await writeFile(path, "doctor", { mode: 0o600 }); if (await readFile(path, "utf8") !== "doctor") throw new Error(); await rm(path); });
await check("FFprobe", async () => { await runTool(c.ffprobe, ["-version"]); });
await check("FFmpeg encoders and required filters", async () => { const filters = await runTool(c.ffmpeg, ["-hide_banner", "-filters"]), encoders = await runTool(c.ffmpeg, ["-hide_banner", "-encoders"]); const all = filters.stdout.toString(); for (const name of ["subtitles", "silencedetect", "afftdn", "scale", "zscale", "tonemap"]) if (!new RegExp(`\\b${name}\\b`).test(all)) throw new Error(); if (!/libx264/.test(encoders.stdout.toString()) || !/\baac\b/.test(encoders.stdout.toString())) throw new Error(); });
await check("Font opens and contains Cyrillic", () => { const font = openSync(c.fontPath) as Font; if (!font.hasGlyphForCodePoint("Я".codePointAt(0)!)) throw new Error(); return font.familyName; });
await check("Silero v5 ONNX real inference", async () => { const vad = await createVad(); try { const p = await vad.frame(new Float32Array(512)); if (!Number.isFinite(p)) throw new Error(); return `valid probability ${p.toFixed(4)}`; } finally { await vad.release(); } });
if (!process.argv.includes("--offline")) {
  for (const name of ["BOT_TOKEN", "ALLOWED_TELEGRAM_USER_IDS", "TELEGRAM_WEBHOOK_SECRET", "MEDIA_SIGNING_SECRET", "OPENAI_API_KEY", "LLM_MODEL", "ASSEMBLYAI_API_KEY"])
    await check(`Configured ${name}`, () => { if (!process.env[name]) throw new Error(); });
  for (const url of ["https://api.openai.com", "https://api.assemblyai.com", "https://api.telegram.org"])
    await check(`HTTPS ${new URL(url).hostname}`, async () => { await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) }); });
}
console.log(failed ? `${failed} checks failed; application is not production-ready.` : "Doctor checks passed for the selected mode.");
process.exitCode = failed ? 1 : 0;
