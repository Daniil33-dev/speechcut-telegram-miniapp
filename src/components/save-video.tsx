"use client";
import { useEffect, useRef, useState } from "react";
import { hasNativeDownload, isDesktopSaveDevice, nativeDownload, prepareShareFile, SHARE_MEMORY_LIMIT } from "@/client/save-video";

export function SaveVideo({ url, bytes, downloadUrl }: { url: string; bytes: number; downloadUrl: string }) {
  const [file, setFile] = useState<File | null>(null), [progress, setProgress] = useState<number | null>(null), [message, setMessage] = useState("");
  const [readyNative, setReadyNative] = useState(false), [saving, setSaving] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setDesktop(isDesktopSaveDevice(window.Telegram?.WebApp?.platform, navigator.userAgent, navigator.maxTouchPoints)); }, []);
  async function downloadDesktop() {
    if (saving) return;
    setSaving(true); setMessage("");
    try {
      const app = window.Telegram?.WebApp;
      if (!hasNativeDownload(app)) throw new Error("Для скачивания на компьютер нужна актуальная версия Telegram.");
      const accepted = await nativeDownload(app!, downloadUrl);
      setMessage(accepted ? "Скачивание началось. Файл сохраняется в папку загрузок Telegram." : "Скачивание отменено.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Не удалось начать скачивание. Повторите попытку."); }
    finally { setSaving(false); }
  }
  async function prepare() {
    setMessage(""); const abort = new AbortController(); controller.current = abort; setProgress(0);
    try {
      if (bytes <= SHARE_MEMORY_LIMIT && typeof navigator.share === "function" && typeof navigator.canShare === "function") {
        const prepared = await prepareShareFile(url, bytes, abort.signal, setProgress);
        if (navigator.canShare({ files: [prepared] })) { setFile(prepared); return; }
      }
      if (!hasNativeDownload(window.Telegram?.WebApp)) throw new Error("Системное сохранение недоступно в этой версии приложения.");
      const response = await fetch(downloadUrl, { method: "HEAD", signal: abort.signal });
      if (!response.ok || Number(response.headers.get("content-length")) !== bytes) throw new Error("Ссылка недоступна. Обновите её в приложении.");
      setReadyNative(true);
    } catch (error) { if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Не удалось подготовить видео."); }
    finally { setProgress(null); controller.current = null; }
  }
  async function share() {
    if ((!file && !readyNative) || saving) return;
    setSaving(true); setMessage("");
    try {
      if (file) { await navigator.share({ files: [file] }); setMessage("Выберите «Сохранить видео» в системном меню."); }
      else {
        const accepted = await nativeDownload(window.Telegram!.WebApp!, downloadUrl);
        setMessage(accepted ? "Загрузка передана Telegram. Приложение можно продолжать использовать." : "Сохранение отменено. Можно открыть меню снова.");
      }
    } catch (error) { if (error instanceof DOMException && error.name === "AbortError") setMessage("Меню сохранения закрыто. Можно открыть его снова."); else setMessage("Не удалось открыть системное сохранение. Попробуйте снова."); }
    finally { setSaving(false); }
  }
  return <div className="save-actions">
    {desktop ? <button className="primary" onClick={downloadDesktop} disabled={saving}>Скачать видео</button>
      : file || readyNative ? <button className="primary" onClick={share} disabled={saving}>{file ? "Открыть меню сохранения" : "Сохранить видео"}</button> : <button className="primary" onClick={prepare} disabled={progress !== null}>Подготовить сохранение</button>}
    {progress !== null && <><progress max="100" value={progress} aria-label="Подготовка видео" /><p>{progress}%</p><button onClick={() => controller.current?.abort()}>Отменить подготовку</button></>}
    {message && <p role="status">{message}</p>}
  </div>;
}
