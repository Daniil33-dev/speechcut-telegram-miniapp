// Read-only diagnosis on the owner's recording. No provider requests or edits.
import { mkdir, writeFile } from "node:fs/promises";
import { Store } from "../src/server/store";
import { privatePath } from "../src/server/storage";
import { analyzeSpeech, overlap } from "../src/render/speech";
import { fitWord, buildEditMap } from "../src/render/edit-map";
const store = new Store();
const jobId = process.argv[2] || (store.db.prepare("SELECT id FROM jobs WHERE deleted_at IS NULL AND json_extract(document,'$.title')='IMG_3777.MOV' AND json_extract(document,'$.lastError.code')='WORD_CHECK_FAILED' ORDER BY updated_at DESC LIMIT 1").get() as { id?: string } | undefined)?.id;
if (!jobId) throw new Error("No matching failed job; supply an explicit job ID");
const job = store.job(jobId), source = store.asset(job.sourceAssetId!, jobId), transcript = store.transcript(job.transcriptId!, jobId);
const analysis = await analyzeSpeech(privatePath(source.storageKey), source.media.duration, new AbortController().signal, { wordHints: transcript.words.filter(w => w.confidence >= .6).map(w => ({ start: w.startMs / 1000, end: w.endMs / 1000 })) });
const failed = transcript.words.flatMap((word, i) => {
  try { fitWord(word, analysis.active); return []; }
  catch {
    const around = { start: word.startMs / 1000 - .4, end: word.endMs / 1000 + .4 };
    return [{ ...word, previous: transcript.words[i - 1], next: transcript.words[i + 1],
      nearbyActive: analysis.active.filter(p => overlap(around, p) > 0), nearbyVad: analysis.speech.filter(p => overlap(around, p) > 0), nearbyQuiet: analysis.rawSilence.filter(p => overlap(around, p) > 0) }];
  }
});
const directory = privatePath(`diagnostics/${jobId}-speech`); await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(`${directory}/analysis.json`, JSON.stringify({ jobId, source, transcript, analysis, failed }, null, 2), { mode: 0o600 });
const selected = store.version((job.approvedVersionId || job.selectedVersionId)!, jobId);
const map = failed.length ? null : buildEditMap(transcript.words, selected.units, job.settings, source.media.duration, analysis.active, analysis.pauses);
console.log(JSON.stringify({ jobId, words: transcript.words.length, total: source.media.duration, confirmedPauses: analysis.pauses, failed, report: `${directory}/analysis.json`,
  noiseFloorDb: analysis.noiseFloorDb, softThresholdDb: analysis.softThresholdDb,
  map: map && { duration: map.duration, ranges: map.ranges.length, words: map.words.length, quietWords: map.words.filter(w => ["w12", "w58"].includes(w.id)) } }));
store.db.close();
