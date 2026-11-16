// Private renderer acceptance on a synthetic recording with real ASR timestamps.
// This deliberately does not publish an Artifact or claim LLM proofreading.
import { randomUUID } from "node:crypto";
import { mkdir, copyFile, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { probe } from "../src/server/media-tools";
import { config } from "../src/server/config";
import { renderVideo } from "../src/render/engine";
import { defaultSettings, type Transcript, type ScriptUnit } from "../src/core/domain";
import { contentHash, validateUnits } from "../src/core/script-document";
const [sourcePath, transcriptPath, editPath] = process.argv.slice(2);
if (!sourcePath || !transcriptPath) throw new Error("Supply synthetic source and transcript JSON.");
const root = config().dataDir, jobId = randomUUID(), sourceId = randomUUID();
await mkdir(`${root}/source`, { recursive: true, mode: 0o700 });
const storageKey = `source/${sourceId}.mp4`; await copyFile(sourcePath, `${root}/${storageKey}`);
const transcript = JSON.parse(await readFile(transcriptPath, "utf8")) as Transcript;
const units: ScriptUnit[] = editPath ? JSON.parse(await readFile(editPath, "utf8")).units : transcript.words.map(w => ({ id: w.id, wordIds: [w.id], text: w.rawText }));
validateUnits(units, transcript.words);
const source = { id: sourceId, jobId, storageKey, kind: "source" as const, mime: "video/mp4", bytes: (await stat(`${root}/${storageKey}`)).size, checksum: transcript.sourceChecksum, media: await probe(`${root}/${storageKey}`), createdAt: Date.now() };
const result = await renderVideo({ source, transcript, settings: defaultSettings, operationId: randomUUID(), version: { id: randomUUID(), jobId, parentId: null, units, author: "user", request: "Синтетическая техническая проверка", contentHash: contentHash(units), createdAt: Date.now() } }, new AbortController().signal, message => console.log(message)).catch((error: unknown) => { const detail = (error as { stderr?: string })?.stderr; if (detail) console.error(detail); throw error; });
const map = JSON.parse(await readFile(`${root}/${result.editMapPath}`, "utf8"));
const report = { ...result.qa, inputDuration: source.media.duration, synthetic: true, llmProofread: !!editPath, published: false,
  openingWord: map.words[0].rawText, closingWord: map.words.at(-1).rawText,
  initialPadding: map.words[0].outputStart, finalPadding: map.duration - map.words.at(-1).outputEnd, outputPath: result.outputPath };
await writeFile(resolve(root, "speech-verification.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report));
