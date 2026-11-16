import { spawn } from "node:child_process";
import { AppError, type MediaInfo } from "../core/domain";
import { config } from "./config";

export function runTool(command: string, args: string[], signal?: AbortSignal, maximum = 8 * 1024 * 1024): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; let bytes = 0, err = "", exceeded = false;
    child.stdout.on("data", (buffer: Buffer) => { bytes += buffer.length; if (bytes > maximum) { exceeded = true; child.kill("SIGTERM"); } else out.push(buffer); });
    child.stderr.on("data", (buffer: Buffer) => { err = (err + buffer.toString()).slice(-100000); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0 && !exceeded) return resolve({ stdout: Buffer.concat(out), stderr: err });
      const error = new AppError(signal?.aborted ? "CANCELLED" : "MEDIA_TOOL_FAILED", signal?.aborted ? "Обработка отменена." : "Не удалось обработать медиа. Проверьте формат исходника.", 422);
      Object.defineProperty(error, "stderr", { value: err, enumerable: false }); reject(error);
    });
  });
}

export async function probe(path: string, signal?: AbortSignal, enforceDuration = true): Promise<MediaInfo> {
  const result = await runTool(config().ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], signal);
  const json = JSON.parse(result.stdout.toString());
  const video = json.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = json.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");
  const duration = Number(json.format?.duration);
  if (!/(^|,)(mov|mp4|matroska|webm)(,|$)/.test(String(json.format?.format_name || ""))) throw new AppError("INVALID_CONTAINER", "Поддерживаются только настоящие MP4, MOV, WebM и MKV.");
  if (!video || !audio || !Number.isFinite(duration) || duration <= 0 || !video.width || !video.height)
    throw new AppError("INVALID_MEDIA", "Нужен видеофайл со звуком и ненулевой длительностью.");
  if (enforceDuration && duration > config().maxDurationSeconds) throw new AppError("MEDIA_TOO_LONG", "Видео должно быть не длиннее 15 минут.");
  if (video.width * video.height > 7680 * 4320) throw new AppError("MEDIA_DIMENSIONS", "Разрешение видео слишком велико.");
  const rotation = Number(video.side_data_list?.find((s: { rotation?: number }) => s.rotation !== undefined)?.rotation || video.tags?.rotate || 0);
  return { duration, width: Number(video.width), height: Number(video.height), rotation, sar: video.sample_aspect_ratio || "1:1",
    videoCodec: video.codec_name, audioCodec: audio.codec_name, hdr: ["smpte2084", "arib-std-b67"].includes(video.color_transfer) };
}
