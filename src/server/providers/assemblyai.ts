import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { AppError, type Operation, type Transcript } from "../../core/domain";
import { config, requireSecret } from "../config";
import { Store } from "../store";
import { privatePath } from "../storage";
import { runTool } from "../media-tools";

type AsrResult = { id: string; status: string; text: string; words: { text: string; start: number; end: number; confidence: number }[]; audio_duration: number; speech_model_used?: string; error?: string };
async function api(path: string, init: RequestInit, signal: AbortSignal) {
  const response = await fetch(`https://api.assemblyai.com/v2/${path}`, { ...init, headers: { authorization: requireSecret("ASSEMBLYAI_API_KEY"), ...init.headers }, signal });
  if (!response.ok) throw new AppError(response.status === 429 || response.status === 402 ? "ASR_QUOTA" : "ASR_UNAVAILABLE", response.status === 429 || response.status === 402 ? "Достигнут лимит AssemblyAI или закончились кредиты." : "Не удалось обратиться к AssemblyAI. Проверьте подключение.", 503, response.status >= 500);
  return response.json();
}
const delay = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new AppError("CANCELLED", "Обработка отменена.", 409));
  const aborted = () => { clearTimeout(timer); reject(new AppError("CANCELLED", "Обработка отменена.", 409)); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
  signal.addEventListener("abort", aborted, { once: true });
});
export async function transcribe(store: Store, operation: Operation, signal: AbortSignal): Promise<Transcript> {
  let op = store.operation(operation.id);
  if (op.checkpoint.transcriptId) return store.transcript(String(op.checkpoint.transcriptId), op.jobId);
  const job = store.job(op.jobId), source = store.asset(job.sourceAssetId!, job.id);
  if (!op.checkpoint.asrRequestId) {
    const audioPath = privatePath(`work/${op.id}/asr.flac`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(privatePath(`work/${op.id}`), { recursive: true, mode: 0o700 });
    await runTool(config().ffmpeg, ["-v", "error", "-y", "-i", privatePath(source.storageKey), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", audioPath], signal);
    store.assertActive(op.id);
    const upload = await api("upload", { method: "POST", body: createReadStream(audioPath) as unknown as BodyInit, duplex: "half" } as RequestInit, signal) as { upload_url: string };
    store.checkpoint(op.id, { asrUploadUrl: upload.upload_url }, "Распознаём речь");
    // Creation is not automatically retried: an ambiguous response could already
    // have created a billable request. Save its ID before any polling.
    const submitted = await api("transcript", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio_url: upload.upload_url, speech_models: [config().asrModel], language_code: "ru", disfluencies: true, format_text: false, punctuate: false }) }, signal) as AsrResult;
    store.recordUsage({ id: `assemblyai:${submitted.id}`, jobId: job.id, operationId: op.id, providerRequestId: submitted.id,
      provider: "assemblyai", model: config().asrModel, kind: "transcribe", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      audioSeconds: source.media.duration, costUsd: null, pricingVersion: null, costSource: "unknown", createdAt: Date.now() });
    store.checkpoint(op.id, { asrRequestId: submitted.id, asrModel: config().asrModel }, "Распознаём речь");
  }
  op = store.operation(op.id);
  let failures = 0;
  for (;;) {
    store.assertActive(op.id);
    let result: AsrResult;
    try { result = await api(`transcript/${encodeURIComponent(String(op.checkpoint.asrRequestId))}`, {}, signal) as AsrResult; failures = 0; }
    catch (error) { if (error instanceof AppError && error.retryable && failures++ < 2) { await delay(3000 * failures, signal); continue; } throw error; }
    if (result.status === "error") throw new AppError("ASR_FAILED", "AssemblyAI не смог распознать запись. Сохранённый исходник можно обработать повторно.", 422, true);
    if (result.status !== "completed") { await delay(3000, signal); continue; }
    const tariff = process.env.ASSEMBLYAI_USD_PER_HOUR;
    const known = !!tariff && !!process.env.ASSEMBLYAI_PRICING_DATE && Number.isFinite(Number(tariff)) && Number(tariff) >= 0;
    store.recordUsage({ id: `assemblyai:${result.id}`, jobId: job.id, operationId: op.id, providerRequestId: result.id,
      provider: "assemblyai", model: result.speech_model_used || String(op.checkpoint.asrModel), kind: "transcribe", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      audioSeconds: result.audio_duration, costUsd: known ? result.audio_duration / 3600 * Number(tariff) : null,
      pricingVersion: known ? `${op.checkpoint.asrModel}:${process.env.ASSEMBLYAI_PRICING_DATE}` : null, costSource: known ? "estimate" : "unknown", createdAt: Date.now() });
    store.assertActive(op.id);
    if (!result.words?.length) throw new AppError("NO_SPEECH", "В записи не найдена речь.");
    const transcript: Transcript = { id: randomUUID(), jobId: job.id, sourceChecksum: source.checksum, providerRequestId: result.id,
      model: result.speech_model_used || String(op.checkpoint.asrModel), rawText: result.text, words: result.words.map((w, i) => ({ id: `w${i}`, rawText: w.text, startMs: w.start, endMs: w.end, confidence: w.confidence })), proofreadingStatus: "pending", createdAt: Date.now() };
    store.atomic(() => { store.assertActive(op.id); store.putTranscript(transcript); const current = store.job(job.id); store.saveJob({ ...current, transcriptId: transcript.id, phase: "proofreading" }); });
    store.checkpoint(op.id, { transcriptId: transcript.id }, "Проверяем текст");
    return transcript;
  }
}
