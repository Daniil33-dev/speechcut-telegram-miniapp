import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../core/domain";
import { config, requireSecret } from "./config";

export function verifyTelegram(initData: string, botToken: string, nowSeconds = Date.now() / 1000) {
  if (!initData || initData.length > 16384) throw new AppError("UNAUTHORIZED", "Откройте приложение через Telegram.", 401);
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  const authDate = Number(params.get("auth_date"));
  if (!/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate) || authDate <= 0 || nowSeconds - authDate > 3600 || authDate - nowSeconds > 30)
    throw new AppError("SESSION_EXPIRED", "Откройте приложение заново через Telegram.", 401);
  const seen = new Set<string>();
  for (const [key] of params) { if (seen.has(key)) throw new AppError("UNAUTHORIZED", "Неверная авторизация.", 401); seen.add(key); }
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", key).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw new AppError("UNAUTHORIZED", "Неверная подпись Telegram.", 401);
  let user: { id?: unknown };
  try { user = JSON.parse(params.get("user") || "{}"); } catch { throw new AppError("UNAUTHORIZED", "Неверная авторизация.", 401); }
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) throw new AppError("UNAUTHORIZED", "Неверный пользователь Telegram.", 401);
  return String(user.id);
}

export function authenticate(request: Request) {
  const c = config();
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(c.appUrl).origin) throw new AppError("FORBIDDEN", "Недоступный источник запроса.", 403);
  let id: string;
  if (c.devAuth && !c.production && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(request.url).hostname)) id = process.env.DEV_USER_ID || "1000000001";
  else id = verifyTelegram(request.headers.get("x-telegram-init-data") || "", requireSecret("BOT_TOKEN"));
  if (!(c.devAuth && !c.production) && !c.allowedUsers.has(id)) throw new AppError("FORBIDDEN", "Доступ к приложению ещё не открыт для этого аккаунта.", 403);
  return id;
}
