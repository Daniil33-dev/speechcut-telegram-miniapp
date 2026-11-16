export class UploadPartError extends Error {
  constructor(message: string, public retryable: boolean) { super(message); }
}
export type UploadProgress = { loaded: number; total: number; percent: number; bytesPerSecond: number; secondsRemaining: number | null };
type PartSender = (part: number, blob: Blob, signal: AbortSignal, progress: (bytes: number) => void) => Promise<void>;
function aborted(signal: AbortSignal) { return signal.reason instanceof Error ? signal.reason : new DOMException("Загрузка отменена.", "AbortError"); }
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(aborted(signal)); return; }
    const cancel = () => { clearTimeout(timer); reject(aborted(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export async function uploadParts({ file, partSize, signal, send, onProgress, concurrency = 3, retryDelayMs = 1000 }: {
  file: Blob; partSize: number; signal: AbortSignal; send: PartSender; onProgress: (progress: UploadProgress) => void; concurrency?: number; retryDelayMs?: number;
}) {
  if (!Number.isSafeInteger(partSize) || partSize <= 0 || !file.size) throw new Error("Некорректный размер загрузки.");
  const controller = new AbortController(), cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
  const count = Math.ceil(file.size / partSize), loaded = new Array<number>(count).fill(0), completed = new Set<number>(), start = performance.now();
  let next = 0, failure: unknown;
  const report = () => {
    const total = loaded.reduce((sum, n) => sum + n, 0), elapsed = (performance.now() - start) / 1000, rate = elapsed > 0 ? total / elapsed : 0;
    onProgress({ loaded: total, total: file.size, percent: completed.size === count ? 100 : Math.min(99, Math.floor(total / file.size * 100)), bytesPerSecond: rate, secondsRemaining: rate > 0 ? Math.ceil((file.size - total) / rate) : null });
  };
  async function worker() {
    while (!controller.signal.aborted && next < count) {
      const part = next++, blob = file.slice(part * partSize, Math.min(file.size, (part + 1) * partSize));
      for (let attempt = 0; ; attempt++) {
        try {
          if (controller.signal.aborted) throw aborted(controller.signal);
          await send(part, blob, controller.signal, bytes => { loaded[part] = Math.max(0, Math.min(blob.size, bytes)); report(); });
          loaded[part] = blob.size; completed.add(part); report(); break;
        } catch (error) {
          if (controller.signal.aborted) throw aborted(controller.signal);
          if (!(error instanceof UploadPartError) || !error.retryable || attempt >= 2) throw error;
          loaded[part] = 0; report(); await pause(retryDelayMs * (attempt + 1), controller.signal);
        }
      }
    }
  }
  try {
    const workers = Array.from({ length: Math.min(count, Math.max(1, Math.min(3, Math.floor(concurrency) || 1))) }, async () => {
      try { await worker(); } catch (error) { if (!controller.signal.aborted) { failure = error; controller.abort(); } }
    });
    await Promise.all(workers); // All requests have settled before complete/cancel.
    if (signal.aborted) throw aborted(signal);
    if (failure) throw failure;
    if (completed.size !== count) throw new Error("Переданы не все части видео.");
  } finally { signal.removeEventListener("abort", cancel); }
}

export function sendUploadPart(url: string, blob: Blob, headers: Record<string, string>, signal: AbortSignal, progress: (bytes: number) => void) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(aborted(signal)); return; }
    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort(), cleanup = () => signal.removeEventListener("abort", cancel);
    xhr.open("PUT", url); xhr.timeout = 180000; xhr.responseType = "json";
    xhr.setRequestHeader("content-type", "application/octet-stream");
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = event => progress(event.loaded);
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadPartError(xhr.response?.error?.message || "Не удалось передать часть видео.", !!xhr.response?.error?.retryable || xhr.status >= 500));
    };
    xhr.onerror = xhr.ontimeout = () => { cleanup(); reject(new UploadPartError("Передача прервалась. Повторяем часть файла.", true)); };
    xhr.onabort = () => { cleanup(); reject(aborted(signal)); };
    signal.addEventListener("abort", cancel, { once: true });
    try { xhr.send(blob); } catch (error) { cleanup(); reject(error); }
  });
}
