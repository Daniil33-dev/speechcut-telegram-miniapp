"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, ScriptVersion, ScriptUnit, Transcript, Settings, UsageEvent } from "@/core/domain";
import { ScriptEditor } from "./script-editor";
import { SaveVideo } from "./save-video";
import { SubtitlePreview } from "./subtitle-preview";
import { ExpenseDetails } from "./expense-details";
import { uploadParts, sendUploadPart, type UploadProgress } from "@/client/upload";

type View = { job: Job; versions: ScriptVersion[]; transcript: Transcript | null; operation: { id: string; stage: string; state: string; createdAt: number } | null; lastOperation: { id: string; state: string } | null;
  artifacts: { id: string; createdAt: number; bytes: number; qaSummary: Record<string, unknown> }[];
  usage: UsageEvent[]; expense: { knownUsd: number; unknownEvents: number; hasUsage: boolean; estimated: boolean }; retention: string; source: { width: number; height: number; rotation: number; duration: number } | null };
type Links = { mediaUrl: string; saveUrl: string; downloadUrl: string; bytes: number };
const phases: Record<string, string> = { draft: "Нужен исходник", uploading: "Загружается", transcribing: "Распознаём речь", proofreading: "Проверяем текст", review: "Сценарий готов", approved: "Сценарий подтверждён", rendering: "Собираем видео", ready: "Видео готово", cancelled: "Обработка отменена", recoverable_error: "Требуется действие" };
class ApiError extends Error { constructor(message: string, public retryable = false) { super(message); } }
async function api<T>(path: string, method = "GET", data?: unknown, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<T> {
  const raw = data instanceof Blob;
  const response = await fetch(`/api/${path}`, { method, headers: { "x-telegram-init-data": window.Telegram?.WebApp?.initData || "", ...(data ? { "content-type": raw ? "application/octet-stream" : "application/json" } : {}), ...extraHeaders }, body: data ? raw ? data : JSON.stringify(data) : undefined, signal });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error?.message || "Не удалось выполнить запрос.", value.error?.retryable || response.status >= 500);
  return value;
}
export function EditorApp() {
  const [jobs, setJobs] = useState<Job[]>([]), [view, setView] = useState<View | null>(null), [step, setStep] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [units, setUnits] = useState<ScriptUnit[]>([]), [request, setRequest] = useState(""), [dirty, setDirty] = useState(false), [invalid, setInvalid] = useState(false), [saveState, setSaveState] = useState(""), [editorEpoch, setEditorEpoch] = useState(0);
  const [progress, setProgress] = useState<number | null>(null), [links, setLinks] = useState<Links | null>(null), [artifactId, setArtifactId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [transfer, setTransfer] = useState<UploadProgress | null>(null), [checkingUpload, setCheckingUpload] = useState(false);
  const latest = useRef(view), saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null), saving = useRef<Promise<void> | null>(null), upload = useRef<{ id: string; lease: string; abort: AbortController } | null>(null), fileInput = useRef<HTMLInputElement>(null);
  latest.current = view;
  const load = useCallback(async (id: string) => { const value = await api<View>(`jobs/${id}`); latest.current = value; setView(value); return value; }, []);
  const refreshList = useCallback(async () => { const result = await api<{ jobs: Job[] }>("jobs"); setJobs(result.jobs); }, []);
  useEffect(() => {
    window.Telegram?.WebApp?.ready(); window.Telegram?.WebApp?.expand();
    refreshList().catch(e => setError(e.message));
    const id = new URLSearchParams(window.location.search).get("job"); if (id) load(id).then(v => setStep(v.job.phase === "ready" ? 4 : v.job.selectedVersionId ? 2 : 1)).catch(e => setError(e.message));
  }, [load, refreshList]);
  const selectedId = view?.job.selectedVersionId;
  useEffect(() => {
    if (!selectedId || !latest.current) return;
    const value = latest.current, version = value.versions.find(v => v.id === selectedId);
    if (!version) return;
    let draft = value.job.draft?.baseVersionId === selectedId ? value.job.draft : null;
    try { const local = JSON.parse(localStorage.getItem(`draft:${value.job.ownerId}:${value.job.id}:${selectedId}`) || "null"); if (local?.baseVersionId === selectedId) draft = local; } catch { /* Optional local recovery. */ }
    setUnits(draft?.units || version.units); setRequest(draft?.request || ""); setDirty(!!draft); setInvalid(false); setSaveState(draft ? "Восстановлен черновик" : "Сохранено"); setEditorEpoch(n => n + 1);
    if (!value.operation) setStep(2);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [selectedId]);
  useEffect(() => { if (!view) return; const timer = setInterval(() => { load(view.job.id).catch(e => setError(e.message)); }, view.operation ? 2000 : 10000); return () => clearInterval(timer); }, [view?.job.id, !!view?.operation, load]);
  useEffect(() => { if (!view?.artifacts.length) return; setArtifactId(current => view.artifacts.some(a => a.id === current) ? current : view.artifacts[0].id); if (view.job.phase === "ready") setStep(4); }, [view?.artifacts.length, view?.job.phase]);
  useEffect(() => { if (!view || !artifactId) return; api<Links>(`jobs/${view.job.id}/media-link`, "POST", { artifactId }).then(setLinks).catch(e => setError(e.message)); }, [artifactId, view?.job.id]);
  useEffect(() => { if (step !== 3 || !view?.job.sourceAssetId) return; setSourceUrl(""); api<{ mediaUrl: string }>(`jobs/${view.job.id}/source-link`, "POST", {}).then(v => setSourceUrl(v.mediaUrl)).catch(e => setError(e.message)); }, [step, view?.job.sourceAssetId]);
  useEffect(() => {
    const current = latest.current; if (!dirty || !selectedId || !current || busy || current.operation) return;
    const draft = { baseVersionId: selectedId, text: units.map(u => u.text).join(" "), units, request };
    try { localStorage.setItem(`draft:${current.job.ownerId}:${current.job.id}:${selectedId}`, JSON.stringify(draft)); } catch { /* Storage may be unavailable. */ }
    if (invalid) return;
    setSaveState("Сохраняем…");
    saveTimer.current = setTimeout(() => {
      saving.current = (async () => {
        const state = latest.current; if (!state) return;
        const job = await api<Job>(`jobs/${state.job.id}/draft`, "PATCH", { revision: state.job.revision, ...draft });
        setView(v => v?.job.id === job.id ? { ...v, job } : v); if (latest.current?.job.id === job.id) latest.current = { ...latest.current, job };
        setSaveState("Черновик сохранён");
      })().catch(e => { setSaveState("Не сохранено на сервере"); setError(e.message); });
    }, 900);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [units, request, dirty, invalid, busy, selectedId]);
  async function perform(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Не удалось выполнить действие."); } finally { setBusy(false); } }
  async function flushManual() {
    if (saveTimer.current) clearTimeout(saveTimer.current); await saving.current;
    const current = latest.current!;
    if (invalid) throw new Error("Сначала исправьте неоднозначную вставку или отмените ввод.");
    if (dirty || current.job.draft) {
      await api(`jobs/${current.job.id}/script/manual`, "POST", { revision: current.job.revision, versionId: current.job.selectedVersionId, units });
      try { localStorage.removeItem(`draft:${current.job.ownerId}:${current.job.id}:${current.job.selectedVersionId}`); } catch { /* Optional storage. */ }
      setDirty(false); return load(current.job.id);
    }
    return current;
  }
  async function createJob() { await perform(async () => { const job = await api<Job>("jobs", "POST", {}); await load(job.id); setStep(1); setLinks(null); setArtifactId(""); }); }
  async function openJob(job: Job) { await perform(async () => { setView(null); setLinks(null); setArtifactId(""); const value = await load(job.id); setStep(value.job.phase === "ready" ? 4 : value.job.selectedVersionId ? 2 : 1); }); }
  async function goList() { if (saveTimer.current) clearTimeout(saveTimer.current); await saving.current; const c = latest.current; if (c && dirty && !invalid && c.job.selectedVersionId && !c.operation) await api(`jobs/${c.job.id}/draft`, "PATCH", { revision: c.job.revision, baseVersionId: c.job.selectedVersionId, text: units.map(u => u.text).join(" "), units, request }); setView(null); latest.current = null; setError(""); await refreshList(); }
  async function uploadFile(file: File) {
    if (file.size > 524288000 || !/\.(mp4|mov|webm|mkv)$/i.test(file.name)) { setError("Нужен MP4, MOV, WebM или MKV до 500 МиБ."); return; }
    await perform(async () => {
      const current = latest.current!; setProgress(0); setTransfer(null); setCheckingUpload(false);
      const abort = new AbortController();
      try {
        const session = await api<{ id: string; lease: string; partSize: number }>(`jobs/${current.job.id}/uploads`, "POST", { revision: current.job.revision, fileName: file.name, bytes: file.size, mime: file.type });
        upload.current = { ...session, abort };
        let lastUpdate = 0;
        await uploadParts({ file, partSize: session.partSize, signal: abort.signal,
          send: (part, blob, signal, report) => sendUploadPart(`/api/uploads/${session.id}/parts/${part}`, blob,
            { "x-upload-lease": session.lease, "x-telegram-init-data": window.Telegram?.WebApp?.initData || "" }, signal, report),
          onProgress: value => { const now = performance.now(); if (now - lastUpdate < 150 && value.percent !== 100) return; lastUpdate = now; setTransfer(value); setProgress(value.percent); } });
        setCheckingUpload(true);
        await api(`uploads/${session.id}/complete`, "POST", {}, abort.signal, { "x-upload-lease": session.lease });
      } catch (e) { if (!abort.signal.aborted) throw e; }
      finally { setProgress(null); setTransfer(null); setCheckingUpload(false); upload.current = null; if (fileInput.current) fileInput.current.value = ""; await load(current.job.id); }
    });
  }
  const currentVersion = view?.versions.find(v => v.id === selectedId), active = !!view?.operation, disabled = busy || active;
  return <main className="app-shell">
    {error && <div role="alert" className="error">{error}<button aria-label="Закрыть сообщение" onClick={() => setError("")}>×</button></div>}
    {!view ? <><h1>Мои ролики</h1><button className="primary" disabled={busy} onClick={createJob}>Создать ролик</button><p className="muted">Загрузите видео → Проверьте сценарий → Сохраните ролик</p>
      {!jobs.length && <p className="empty">Пока нет роликов</p>}<div className="job-list">{jobs.map(job => <button key={job.id} className="job-card" onClick={() => openJob(job)}><strong>{job.title}</strong><span>{phases[job.phase]}</span></button>)}</div></> : <>
      <button className="text-link" onClick={() => void perform(goList)}>← Мои ролики</button>
      <nav aria-label="Этап монтажа"><p className="mobile-step">Шаг {step} из 4 · {["Видео", "Сценарий", "Субтитры", "Результат"][step - 1]}</p><ol className="steps">{["Видео", "Сценарий", "Субтитры", "Результат"].map((label, i) => <li key={label} aria-current={step === i + 1 ? "step" : undefined}>{i + 1}. {label}</li>)}</ol></nav>
      <p className="file-name" title={view.job.title}>{view.job.title}</p>
      {view.job.lastError && <p role="alert" className="error">{view.job.lastError.message}</p>}
      {active && <section className="processing" aria-live="polite"><h2>{view.operation!.stage}</h2><p>Видео обрабатывается на сервере. Приложение можно закрыть.</p><button onClick={() => perform(async () => { await api(`operations/${view.operation!.id}/cancel`, "POST", {}); await load(view.job.id); })}>Остановить обработку</button></section>}
      {step === 1 && <section><h1>{view.job.sourceAssetId ? "Видео загружено" : "Загрузите видео"}</h1><p>{view.job.sourceAssetId ? "Исходник сохранён на сервере. Повторная загрузка не нужна." : "MP4, MOV, WebM или MKV · до 500 МиБ · до 15 минут"}</p>
        {!view.job.sourceAssetId && <><input ref={fileInput} type="file" hidden accept=".mp4,.mov,.webm,.mkv,video/*" onChange={e => { const file = e.target.files?.[0]; if (file) void uploadFile(file); }} /><button className="primary" disabled={disabled || progress !== null} onClick={() => fileInput.current?.click()}>Выбрать видео</button></>}
        {progress !== null && <><progress value={progress} max="100" aria-label="Загрузка видео" /><p role="status">{checkingUpload ? "Видео передано. Проверяем файл на сервере…" : `${progress}%${transfer ? ` · ${(transfer.loaded / 1048576).toFixed(1)} из ${(transfer.total / 1048576).toFixed(1)} МиБ · ${(transfer.bytesPerSecond / 1048576).toFixed(1)} МиБ/с${transfer.secondsRemaining !== null ? ` · осталось ≈ ${transfer.secondsRemaining} с` : ""}` : ""}`}</p><p>Оставьте приложение открытым до конца загрузки.</p><button onClick={async () => { const u = upload.current; if (!u) return; u.abort.abort(); await api(`uploads/${u.id}`, "DELETE", undefined, undefined, { "x-upload-lease": u.lease }).catch(e => setError(e.message)); }}>Отменить загрузку</button></>}
        {selectedId && <button className="primary" onClick={() => setStep(2)}>Открыть сценарий</button>}
      </section>}
      {step === 2 && currentVersion && <section><h1>Сценарий</h1><p className="muted">Удалите фразу из текста — она исчезнет из видео. Исправление написания меняет субтитры, сохраняя звук.</p>
        <ScriptEditor key={`${currentVersion.id}:${editorEpoch}`} units={units.length ? units : currentVersion.units} disabled={disabled} onChange={next => { setUnits(next); setDirty(true); setInvalid(false); }} onError={(message, text) => { setInvalid(true); setDirty(true); setError(message); try { localStorage.setItem(`invalid-draft:${view.job.ownerId}:${view.job.id}:${selectedId}`, text); } catch { /* Optional storage. */ } }} />
        <p role="status" className="muted">{saveState}</p><button disabled={disabled} onClick={() => { setUnits(currentVersion.units); setRequest(""); setDirty(true); setInvalid(false); setEditorEpoch(n => n + 1); }}>Отменить ввод</button>
        <label htmlFor="edit-request">Что изменить</label><textarea id="edit-request" value={request} disabled={disabled} maxLength={2000} rows={3} onChange={e => { setRequest(e.target.value); setDirty(true); }} placeholder="Например: убери повторы и перенеси законченную фразу в начало" />
        <div className="suggestions">{["Убрать воду", "Убрать повторы", "Найти хук"].map(text => <button key={text} disabled={disabled} onClick={() => { setRequest(text); setDirty(true); }}>{text}</button>)}</div>
        <details><summary>История версий</summary>{view.versions.map((version, i) => <button className="version" key={version.id} disabled={disabled || version.id === selectedId} onClick={() => perform(async () => { if (saveTimer.current) clearTimeout(saveTimer.current); await saving.current; const current = latest.current!; await api(`jobs/${current.job.id}/script/select`, "POST", { revision: current.job.revision, versionId: version.id }); setDirty(false); await load(current.job.id); })}>Версия {i + 1} · {version.request}</button>)}</details>
        <button disabled={disabled || selectedId === view.versions[0]?.id} onClick={() => perform(async () => { if (saveTimer.current) clearTimeout(saveTimer.current); await saving.current; const current = latest.current!; await api(`jobs/${current.job.id}/script/select`, "POST", { revision: current.job.revision, versionId: current.versions[0].id }); setDirty(false); await load(current.job.id); })}>Вернуть исходный сценарий</button>
        <div className="sticky-action">{request.trim() ? <button className="primary" disabled={disabled || invalid} onClick={() => perform(async () => { const current = await flushManual(); await api(`jobs/${current.job.id}/script/edit`, "POST", { revision: current.job.revision, versionId: current.job.selectedVersionId, request: request.trim(), idempotencyKey: crypto.randomUUID() }); await load(current.job.id); })}>Показать новый сценарий</button>
          : <button className="primary" disabled={disabled || invalid} onClick={() => perform(async () => { const current = await flushManual(), version = current.versions.find(v => v.id === current.job.selectedVersionId)!; await api(`jobs/${current.job.id}/approve`, "POST", { revision: current.job.revision, versionId: version.id, contentHash: version.contentHash }); await load(current.job.id); setStep(3); })}>Подтвердить → Субтитры</button>}</div>
      </section>}
      {step === 3 && <section><h1>Субтитры</h1><p className="muted">Положение субтитров применяется к сохранённому сценарию.</p><label className="toggle"><input type="checkbox" checked={view.job.settings.subtitles} disabled={disabled} onChange={e => { const checked = e.target.checked; void perform(async () => { const c = latest.current!; await api(`jobs/${c.job.id}/settings`, "PATCH", { revision: c.job.revision, settings: { ...c.job.settings, subtitles: checked } }); await load(c.job.id); }); }} />Субтитры</label>
        {sourceUrl && view.source && <SubtitlePreview url={sourceUrl} width={Math.abs(view.source.rotation) % 180 === 90 ? view.source.height : view.source.width} height={Math.abs(view.source.rotation) % 180 === 90 ? view.source.width : view.source.height} settings={view.job.settings} text={currentVersion?.units.slice(0, 2).map(u => u.text).join(" ") || "Субтитры"} />}
        <label htmlFor="position">Положение: {view.job.settings.subtitlePosition}%</label><input id="position" type="range" min="15" max="85" defaultValue={view.job.settings.subtitlePosition} disabled={disabled} onChange={e => { const position = Number(e.target.value); setView(v => v ? { ...v, job: { ...v.job, settings: { ...v.job.settings, subtitlePosition: position } } } : v); }} onPointerUp={() => perform(async () => { const c = latest.current!; await api(`jobs/${c.job.id}/settings`, "PATCH", { revision: c.job.revision, settings: c.job.settings }); await load(c.job.id); })} onKeyUp={() => perform(async () => { const c = latest.current!; await api(`jobs/${c.job.id}/settings`, "PATCH", { revision: c.job.revision, settings: c.job.settings }); await load(c.job.id); })} />
        <label className="toggle"><input type="checkbox" disabled={disabled} checked={view.job.settings.removePauses} onChange={e => { const checked = e.target.checked; void perform(async () => { const c = latest.current!; await api(`jobs/${c.job.id}/settings`, "PATCH", { revision: c.job.revision, settings: { ...c.job.settings, removePauses: checked } }); await load(c.job.id); }); }} />Удалить паузы длиннее 0,3 с</label>
        <button disabled={disabled} onClick={() => setStep(2)}>← К сценарию</button><div className="sticky-action"><button className="primary" disabled={disabled} onClick={() => perform(async () => { const c = latest.current!; await api(`jobs/${c.job.id}/render`, "POST", { revision: c.job.revision, versionId: c.job.approvedVersionId, settings: c.job.settings, idempotencyKey: crypto.randomUUID() }); await load(c.job.id); })}>Собрать видео</button></div></section>}
      {step === 4 && <section><h1>Готовое видео</h1>{view.artifacts.length > 1 && <label>Версия результата<select value={artifactId} onChange={e => { setArtifactId(e.target.value); setLinks(null); }}>{view.artifacts.map((a, i) => <option key={a.id} value={a.id}>Результат {view.artifacts.length - i} · {new Date(a.createdAt).toLocaleString("ru-RU")}</option>)}</select></label>}
        {links && <><video className="video-player" src={links.mediaUrl} controls controlsList="nodownload" playsInline preload="metadata" /><SaveVideo key={links.mediaUrl} url={links.mediaUrl} downloadUrl={links.downloadUrl} bytes={links.bytes} /></>}
        <button onClick={() => perform(async () => { setLinks(await api<Links>(`jobs/${view.job.id}/media-link`, "POST", { artifactId })); })}>Обновить ссылку</button><button onClick={() => setStep(2)}>Вернуться к сценарию</button>
      </section>}
      {!!view.artifacts.length && step !== 4 && <button onClick={() => setStep(4)}>Открыть готовый результат</button>}
      {["recoverable_error", "cancelled"].includes(view.job.phase) && !active && view.lastOperation && <button disabled={busy} onClick={() => perform(async () => { await api(`operations/${view.lastOperation!.id}/retry`, "POST", { idempotencyKey: crypto.randomUUID() }); await load(view.job.id); })}>Повторить обработку</button>}
      <details className="expenses"><summary>Расходы и хранение</summary><p>{view.expense.unknownEvents && view.expense.knownUsd === 0 ? "Расход: тариф уточняется" : view.expense.hasUsage ? `${view.expense.estimated ? "≈ " : ""}$${view.expense.knownUsd.toFixed(6)}${view.expense.unknownEvents ? " + расход с неуточнённым тарифом" : ""}` : "Расход: нет данных"}</p><p>{view.retention}</p><ExpenseDetails events={view.usage} /></details>
      <button className="danger" disabled={disabled || progress !== null} onClick={() => { if (window.confirm("Удалить ролик и его файлы?")) void perform(async () => { const c = latest.current!; await api(`jobs/${c.job.id}`, "DELETE", { revision: c.job.revision }); latest.current = null; setDirty(false); await goList(); }); }}>Удалить ролик и файлы</button>
    </>}
  </main>;
}
