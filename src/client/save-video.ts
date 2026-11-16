export const SHARE_MEMORY_LIMIT = 48 * 1024 * 1024;
export type TelegramWebApp = {
  initData: string; ready: () => void; expand: () => void; openLink: (url: string) => void; viewportStableHeight?: number;
  platform?: string; isVersionAtLeast?: (version: string) => boolean;
  downloadFile?: (params: { url: string; file_name: string }, callback?: (accepted: boolean) => void) => void;
};
declare global { interface Window { Telegram?: { WebApp?: TelegramWebApp } } }
export function hasNativeDownload(app?: TelegramWebApp) {
  return !!app?.downloadFile && app.isVersionAtLeast?.("8.0") === true;
}
export function isDesktopSaveDevice(platform: string | undefined, userAgent: string, maxTouchPoints = 0) {
  if (platform === "ios" || platform === "android") return false;
  if (platform === "macos" || platform === "tdesktop") return true;
  return !(/iPhone|iPad|iPod|Android/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1));
}
export async function prepareShareFile(url: string, bytes: number, signal: AbortSignal, progress: (percent: number) => void, fetcher: typeof fetch = fetch) {
  if (bytes > SHARE_MEMORY_LIMIT) throw new Error("Этот ролик слишком большой для системного меню.");
  const response = await fetcher(url, { signal });
  if (!response.ok || !response.body) throw new Error("Ссылка недоступна. Обновите ссылку в приложении.");
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("video/mp4")) throw new Error("Сервер вернул другой тип файла. Обновите ссылку.");
  const reader = response.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = []; let received = 0, complete = false;
  try {
    for (;;) {
      signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
      received += item.value.length;
      if (received > SHARE_MEMORY_LIMIT || received > bytes) throw new Error("Размер переданного видео не совпал. Повторите подготовку.");
      parts.push(new Uint8Array(item.value)); progress(Math.min(99, Math.floor(received / bytes * 100)));
    }
    if (received !== bytes) throw new Error("Видео передалось не полностью. Повторите подготовку.");
    const file = new File(parts, "video.mp4", { type: "video/mp4" }); complete = true; progress(100); return file;
  } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function nativeDownload(app: TelegramWebApp, url: string) {
  return new Promise<boolean>((resolve, reject) => {
    if (!hasNativeDownload(app)) { reject(new Error("Системное сохранение недоступно в этой версии Telegram.")); return; }
    const timer = setTimeout(() => reject(new Error("Окно сохранения не ответило. Можно повторить попытку.")), 60000);
    try { app.downloadFile!({ url, file_name: "video.mp4" }, accepted => { clearTimeout(timer); resolve(accepted); }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}
