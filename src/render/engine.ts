import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { AppError, type Asset, type ScriptVersion, type Settings, type Transcript } from "../core/domain";
import { contentHash, wordIds } from "../core/script-document";
import { config } from "../server/config";
import { ensureSpace, privatePath } from "../server/storage";
import { probe, runTool } from "../server/media-tools";
import { analyzeSpeech, WAVEFORM } from "./speech";
import { verifyWordAudio } from "./word-audio";
import { buildEditMap, RENDER_REVISION } from "./edit-map";
import { makeCaptions } from "./captions";

const filterPath = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''")}'`;
// FFmpeg duration options reject scientific notation, including floating point
// residue near zero at otherwise exact 100 ms boundaries.
export const ffmpegSeconds = (value: number) => Math.max(0, value).toFixed(9);
export async function renderVideo(input: { source: Asset; transcript: Transcript; version: ScriptVersion; settings: Settings; operationId: string }, signal: AbortSignal, stage: (message: string) => void) {
  const { source, transcript, version, settings, operationId } = input;
  const work = privatePath(`work/${operationId}`), sourcePath = privatePath(source.storageKey);
  await ensureSpace(Math.max(source.bytes * 4, 512 * 1024 * 1024));
  await mkdir(work, { recursive: true, mode: 0o700 });
  stage("Проверяем границы речи");
  const analysis = await analyzeSpeech(sourcePath, source.media.duration, signal, { wordHints: transcript.words.filter(w => w.confidence >= .6).map(w => ({ start: w.startMs / 1000, end: w.endMs / 1000 })) });
  await writeFile(join(work, "source-analysis.json"), JSON.stringify(analysis, null, 2), { mode: 0o600 });
  const map = buildEditMap(transcript.words, version.units, settings, source.media.duration, analysis.active, analysis.pauses);
  let width = source.media.width, height = source.media.height;
  const [sarN, sarD] = source.media.sar.split(":").map(Number);
  if (sarN > 0 && sarD > 0) width *= sarN / sarD;
  if (Math.abs(source.media.rotation) % 180 === 90) [width, height] = [height, width];
  const scale = Math.min(1, 1080 / Math.min(width, height));
  width = Math.max(2, Math.round(width * scale / 2) * 2); height = Math.max(2, Math.round(height * scale / 2) * 2);
  const captions = settings.subtitles ? makeCaptions(version.units, map.words, width, height, settings.subtitlePosition, config().fontPath) : { ass: "", cues: [] };
  const assPath = join(work, "subtitles.ass"); await writeFile(assPath, captions.ass);
  const audit = { ...map, sourceChecksum: source.checksum, scriptVersionId: version.id, scriptHash: version.contentHash,
    settingsHash: createHash("sha256").update(JSON.stringify(settings)).digest("hex"), sourceAnalysis: analysis, captions: captions.cues, width, height, toneMapped: source.media.hdr };
  await writeFile(join(work, "edit-map.json"), JSON.stringify(audit, null, 2), { mode: 0o600 });
  const fragments: string[] = [];
  for (let i = 0; i < map.ranges.length; i++) {
    signal.throwIfAborted(); stage(`Собираем фрагмент ${i + 1} из ${map.ranges.length}`);
    const range = map.ranges[i], length = range.outputEnd - range.outputStart;
    const path = join(work, `part-${String(i).padStart(5, "0")}.mkv`);
    const tone = source.media.hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv," : "";
    const vf = `trim=start=${ffmpegSeconds(range.start)}:end=${ffmpegSeconds(range.end)},setpts=PTS-STARTPTS,${tone}scale=${width}:${height}:flags=lanczos,setsar=1,fps=30,tpad=start_mode=clone:start_duration=${ffmpegSeconds(range.padBefore)}:stop_mode=clone:stop_duration=1,trim=duration=${ffmpegSeconds(length)},format=yuv420p`;
    const af = `aresample=48000,atrim=start_sample=${Math.round(range.start * 48000)}:end_sample=${Math.round(range.end * 48000)},asetpts=PTS-STARTPTS,adelay=${Math.round(range.padBefore * 48000)}S:all=1,apad,atrim=duration=${ffmpegSeconds(length)},afade=t=in:st=0:d=0.008,afade=t=out:st=${ffmpegSeconds(length - 0.008)}:d=0.008`;
    await runTool(config().ffmpeg, ["-v", "error", "-y", "-threads", "2", "-filter_threads", "1", "-i", sourcePath, "-map", "0:v:0", "-map", "0:a:0", "-vf", vf, "-af", af,
      "-t", ffmpegSeconds(length), "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-threads", "2", "-c:a", "pcm_s16le", "-map_metadata", "-1", path], signal);
    fragments.push(path);
  }
  const concatPath = join(work, "concat.txt");
  await writeFile(concatPath, fragments.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const outputPath = join(work, "result.mp4"); stage("Кодируем MP4");
  await runTool(config().ffmpeg, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
    ...(settings.subtitles ? ["-vf", `subtitles=filename=${filterPath(assPath)}:fontsdir=${filterPath(dirname(config().fontPath))}`] : []),
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-map_metadata", "-1", "-metadata:s:v:0", "rotate=0", ...(source.media.hdr ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"] : []), outputPath], signal);
  stage("Проверяем готовое видео");
  const media = await probe(outputPath, signal, false);
  await runTool(config().ffmpeg, ["-v", "error", "-i", outputPath, "-f", "null", "-"], signal);
  if (media.videoCodec !== "h264" || media.audioCodec !== "aac" || media.width !== width || media.height !== height || Math.abs(media.duration - map.duration) > 0.08 || media.rotation !== 0 || media.sar !== "1:1")
    throw new AppError("MEDIA_CHECK_FAILED", "Готовое видео не прошло техническую проверку.");
  if (JSON.stringify(wordIds(version.units)) !== JSON.stringify(map.words.map(w => w.id)) || contentHash(version.units) !== version.contentHash)
    throw new AppError("WORD_CHECK_FAILED", "Проверка обнаружила изменение одобренного сценария.");
  const outputAnalysis = await analyzeSpeech(outputPath, media.duration, signal, { noiseFloorDb: analysis.noiseFloorDb, wordHints: map.words.map(w => ({ start: w.outputStart, end: w.outputEnd })) });
  await writeFile(join(work, "output-audit.json"), JSON.stringify(outputAnalysis, null, 2), { mode: 0o600 });
  const wordAudit = await verifyWordAudio(analysis[WAVEFORM], outputAnalysis[WAVEFORM], map, analysis.softSpeech, analysis.softThresholdDb, signal);
  await writeFile(join(work, "word-audit.json"), JSON.stringify(wordAudit, null, 2), { mode: 0o600 });
  if (!wordAudit.passed) throw new AppError("WORD_CHECK_FAILED", "Звук готового видео не совпал с исходными словами. Результат сохранён для проверки и не опубликован.", 422, true);
  let outputPauses = 0;
  if (settings.removePauses) {
    outputPauses = outputAnalysis.pauses.length;
    if (outputPauses) throw new AppError("PAUSE_CHECK_FAILED", "В готовом видео остались подтверждённые длинные паузы. Результат не опубликован.", 422, true);
  }
  if (captions.cues.some(c => c.lines.length > 2 || c.start < 0 || c.end > media.duration + 0.03 || c.measuredWidths.some(w => w > width * 0.8)))
    throw new AppError("CAPTION_CHECK_FAILED", "Субтитры не прошли проверку расположения.");
  const qa = { duration: media.duration, wordCount: map.words.length, remainingPauses: settings.removePauses ? outputPauses : null,
    codecs: "H.264/AAC", decoded: true, subtitleCues: captions.cues.length, toneMapped: source.media.hdr, listened: false, rendererRevision: RENDER_REVISION,
    wordSignalCheck: { verifiedWords: wordAudit.verifiedWords, minCorrelation: wordAudit.minCorrelation, maxLevelChangeDb: wordAudit.maxLevelChangeDb, maxOffsetMs: wordAudit.maxOffsetMs } };
  await writeFile(join(work, "qa.json"), JSON.stringify(qa, null, 2));
  for (const path of fragments) await rm(path, { force: true });
  await rm(concatPath, { force: true });
  const bytes = (await stat(outputPath)).size;
  // Hash a stream in the worker when publishing; this path is not a public asset.
  return { outputPath, editMapPath: `work/${operationId}/edit-map.json`, media, qa, bytes };
}
