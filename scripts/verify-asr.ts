// Explicit integration check: uses AssemblyAI credits on the supplied test media.
// Not part of npm test. It never marks unproofread text approved or ready.
import { randomUUID, createHash } from "node:crypto";
import { mkdir, copyFile, writeFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "../src/server/db";
import { Store } from "../src/server/store";
import { probe } from "../src/server/media-tools";
import { transcribe } from "../src/server/providers/assemblyai";

const sourcePath = process.argv[2]; if (!sourcePath || process.env.NODE_ENV === "production") throw new Error("Supply a synthetic test video outside production.");
const root = resolve(".local/asr-verification"); process.env.DATA_DIR = root;
await mkdir(`${root}/source`, { recursive: true, mode: 0o700 });
const store = new Store(openDatabase(`${root}/verification.sqlite`)), job = store.createJob("synthetic-test", "Синтетическая русская речь");
const sourceId = randomUUID(), key = `source/${sourceId}.mp4`, target = `${root}/${key}`;
await copyFile(sourcePath, target); const media = await probe(target);
store.addAsset({ id: sourceId, jobId: job.id, kind: "source", storageKey: key, mime: "video/mp4", bytes: (await stat(target)).size,
  checksum: createHash("sha256").update(await readFile(target)).digest("hex"), media, createdAt: Date.now() });
const attached = store.saveJob({ ...job, sourceAssetId: sourceId });
const op = store.atomic(() => store.enqueue(attached, "transcribe", {}, randomUUID())); store.claim("integration-check");
const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 240000);
try {
  const transcript = await transcribe(store, op, controller.signal);
  store.finish(op.id, current => ({ ...current, phase: "proofreading" }));
  await writeFile(`${root}/transcript.json`, JSON.stringify(transcript, null, 2), { mode: 0o600 });
  await writeFile(`${root}/usage.json`, JSON.stringify(store.usage(job.id), null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ provider: "assemblyai", model: transcript.model, wordCount: transcript.words.length, duration: media.duration, text: transcript.rawText, proofread: false }));
} catch (error) {
  store.fail(op.id, { code: "ASR_TEST_FAILED", message: "Техническая проверка синтетической записи не пройдена.", retryable: false }); throw error;
} finally { clearTimeout(timeout); store.db.close(); }
