import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { AppError, type Operation, type Settings } from "../core/domain";
import { Store } from "./store";
import { config } from "./config";
import { transcribe } from "./providers/assemblyai";
import { OpenAiProvider } from "./providers/llm";
import { privatePath } from "./storage";
import { renderVideo } from "../render/engine";
import { RENDER_REVISION } from "../render/edit-map";
import { flushOutbox } from "./telegram";

async function checksum(path: string) { const digest = createHash("sha256"); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest("hex"); }
export async function executeOperation(store: Store, op: Operation, signal: AbortSignal) {
  const job = store.job(op.jobId);
  if (op.type === "transcribe" || op.type === "proofread") {
    // Validate both paid services before creating a billable ASR request.
    const llm = new OpenAiProvider(store);
    const transcript = job.transcriptId ? store.transcript(job.transcriptId, job.id) : await transcribe(store, op, signal);
    store.checkpoint(op.id, {}, "Проверяем текст");
    store.atomic(() => { const { job: current } = store.assertActive(op.id); if (current.phase !== "proofreading") store.saveJob({ ...current, phase: "proofreading" }); });
    const units = await llm.proofreadTranscript(transcript.words, op, signal);
    store.finish(op.id, current => {
      const version = store.addVersion(job.id, null, units, "Проверка исходной расшифровки", "ai");
      store.putTranscript({ ...transcript, proofreadingStatus: "completed" });
      return { ...current, transcriptId: transcript.id, selectedVersionId: version.id, approvedVersionId: null, phase: "review" };
    }, "Сценарий готов. Проверьте текст в приложении.");
  } else if (op.type === "edit") {
    const transcript = store.transcript(job.transcriptId!, job.id), parent = store.version(String(op.payload.versionId), job.id);
    const units = await new OpenAiProvider(store).proposeEdit(transcript.words, parent.units, String(op.payload.request), op, signal);
    store.finish(op.id, current => {
      if (current.selectedVersionId !== parent.id) throw new AppError("VERSION_CONFLICT", "Сценарий изменился во время обработки.", 409);
      const version = store.addVersion(job.id, parent.id, units, String(op.payload.request), "ai");
      return { ...current, selectedVersionId: version.id, approvedVersionId: null, draft: null, phase: "review" };
    }, "Сценарий обновлён. Подтвердите нужную версию перед сборкой.");
  } else if (op.type === "render") {
    const version = store.version(String(op.payload.versionId), job.id), settings = op.payload.settings as Settings;
    if (job.approvedVersionId !== version.id) throw new AppError("APPROVAL_REQUIRED", "Версия больше не одобрена.", 409);
    const inputsHash = createHash("sha256").update(JSON.stringify({ version: version.contentHash, settings, source: job.sourceAssetId })).digest("hex");
    const checkpoint = store.operation(op.id).checkpoint;
    let result = checkpoint.rendererRevision === RENDER_REVISION && checkpoint.inputsHash === inputsHash ? checkpoint.renderOutput as Awaited<ReturnType<typeof renderVideo>> | undefined : undefined;
    if (result && !(await stat(result.outputPath).catch(() => null))) {
      if (typeof checkpoint.publishingStorageKey === "string" && await stat(privatePath(checkpoint.publishingStorageKey)).catch(() => null)) result = { ...result, outputPath: privatePath(checkpoint.publishingStorageKey) };
      else result = undefined;
    }
    if (!result) {
      result = await renderVideo({ source: store.asset(job.sourceAssetId!, job.id), transcript: store.transcript(job.transcriptId!, job.id), version, settings, operationId: op.id }, signal, stage => store.checkpoint(op.id, {}, stage));
      store.checkpoint(op.id, { rendererRevision: RENDER_REVISION, inputsHash, renderOutput: result }, "Публикуем результат");
    }
    store.assertActive(op.id);
    const resumedPublishing = result.outputPath === (typeof checkpoint.publishingStorageKey === "string" ? privatePath(checkpoint.publishingStorageKey) : "");
    const id = resumedPublishing ? String(checkpoint.publishingAssetId) : randomUUID(), storageKey = `output/${id}.mp4`, digest = await checksum(result.outputPath);
    await mkdir(privatePath("output"), { recursive: true, mode: 0o700 });
    // Persist destination before rename so restart can recover the move.
    store.checkpoint(op.id, { publishingAssetId: id, publishingStorageKey: storageKey });
    if (!resumedPublishing) await rename(result.outputPath, privatePath(storageKey));
    store.finish(op.id, current => {
      if (current.approvedVersionId !== version.id) throw new AppError("APPROVAL_REQUIRED", "Версия больше не одобрена.", 409);
      store.addAsset({ id, jobId: job.id, kind: "output", storageKey, mime: "video/mp4", bytes: result!.bytes, checksum: digest, media: result!.media, createdAt: Date.now() });
      store.addArtifact({ id: randomUUID(), jobId: job.id, scriptVersionId: version.id, settings, rendererRevision: RENDER_REVISION,
        outputAssetId: id, editMapPath: result!.editMapPath, qaSummary: result!.qa, createdAt: Date.now() });
      return { ...current, phase: "ready" };
    }, "Видео готово. Просмотр и сохранение доступны в приложении.");
  } else throw new AppError("UNSUPPORTED_OPERATION", "Неизвестная операция.");
}

async function main() {
  config(); const store = new Store(), workerId = randomUUID(); let stopping = false; let active: AbortController | null = null;
  const stop = () => { stopping = true; active?.abort(); }; process.on("SIGTERM", stop); process.on("SIGINT", stop);
  console.log("Speechcut worker started");
  while (!stopping) {
    store.db.prepare("INSERT INTO worker_heartbeat VALUES(?,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at").run(workerId, Date.now());
    await flushOutbox(store);
    const op = store.claim(workerId);
    if (!op) { await new Promise(resolve => setTimeout(resolve, 1500)); continue; }
    active = new AbortController(); const controller = active;
    const timer = setInterval(() => { try { if (!store.heartbeat(op.id, workerId)) controller.abort(); } catch { controller.abort(); } }, 3000);
    try { await executeOperation(store, op, controller.signal); }
    catch (error) {
      const diagnostic = (error as { stderr?: string })?.stderr;
      if (diagnostic) { await mkdir(privatePath(`work/${op.id}`), { recursive: true, mode: 0o700 }); await writeFile(privatePath(`work/${op.id}/ffmpeg-error.log`), diagnostic, { mode: 0o600 }); }
      if (!stopping) {
        const detail = error instanceof AppError ? error : new AppError(controller.signal.aborted ? "CANCELLED" : "PROCESSING_FAILED", controller.signal.aborted ? "Обработка отменена." : "Обработка прервана. Исходник и сценарий сохранены.", 503, true);
        try { store.fail(op.id, { code: detail.code, message: detail.message, retryable: detail.retryable }); } catch { /* Deleted jobs remain deleted. */ }
        console.error(JSON.stringify({ operationId: op.id, code: detail.code }));
      }
    } finally { clearInterval(timer); active = null; }
  }
  store.db.close();
}
if (process.argv[1]?.endsWith("worker.ts")) main().catch(() => { console.error("Worker startup failed; check configuration and database."); process.exitCode = 1; });
