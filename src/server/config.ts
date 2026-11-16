import { resolve } from "node:path";
import { AppError } from "../core/domain";

export function config() {
  const production = process.env.NODE_ENV === "production";
  const devAuth = process.env.DEV_AUTH_ENABLED === "true";
  if (production && devAuth) throw new AppError("INSECURE_CONFIG", "Локальный доступ запрещён в production.", 503);
  const dataDir = resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || ".local/data");
  return {
    production, devAuth, dataDir, dbPath: resolve(/*turbopackIgnore: true*/ process.env.SQLITE_PATH || `${dataDir}/editor.sqlite`),
    appUrl: process.env.APP_URL || "http://127.0.0.1:3048",
    allowedUsers: new Set((process.env.ALLOWED_TELEGRAM_USER_IDS || "").split(",").map(x => x.trim()).filter(Boolean)),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 524288000), maxDurationSeconds: Number(process.env.MAX_DURATION_SECONDS || 900),
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg", ffprobe: process.env.FFPROBE_PATH || "ffprobe",
    fontPath: process.env.FONT_PATH || "", vadModelPath: process.env.VAD_MODEL_PATH || "",
    asrModel: process.env.ASSEMBLYAI_MODEL || "universal-3-6-pro-preview", llmModel: process.env.LLM_MODEL || ""
  };
}
export function requireSecret(name: string) { const value = process.env[name]; if (!value?.trim()) throw new AppError("SERVICE_NOT_CONFIGURED", "Сервис ещё не подключён.", 503); return value; }
