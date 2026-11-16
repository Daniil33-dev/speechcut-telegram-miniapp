import { timingSafeEqual } from "node:crypto";
import { AppError } from "../core/domain";
import { requireSecret, config } from "./config";
import { Store } from "./store";

export async function telegram(method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${requireSecret("BOT_TOKEN")}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new AppError("TELEGRAM_UNAVAILABLE", "Telegram временно недоступен.", 503, true);
  return result.result;
}
export async function webhook(store: Store, request: Request) {
  const supplied = request.headers.get("x-telegram-bot-api-secret-token") || "", secret = requireSecret("TELEGRAM_WEBHOOK_SECRET");
  const suppliedBytes = Buffer.from(supplied), secretBytes = Buffer.from(secret);
  if (suppliedBytes.length !== secretBytes.length || !timingSafeEqual(suppliedBytes, secretBytes)) throw new AppError("FORBIDDEN", "Неверный webhook.", 403);
  const raw = await request.text(); if (raw.length > 100000) throw new AppError("TOO_LARGE", "Запрос слишком велик.", 413);
  const update = JSON.parse(raw);
  if (!Number.isSafeInteger(update.update_id)) throw new AppError("INVALID_UPDATE", "Неверное обновление Telegram.");
  store.atomic(() => {
    const changed = store.db.prepare("INSERT OR IGNORE INTO telegram_updates VALUES(?,?)").run(String(update.update_id), Date.now());
    if (!changed.changes) return;
    const message = update.message;
    if (message && Number.isSafeInteger(message.from?.id) && Number.isSafeInteger(message.chat?.id)) {
      const allowed = config().allowedUsers.has(String(message.from.id));
      const reply = { chat_id: message.chat.id, text: allowed ? "Загрузите видео и отредактируйте сценарий в приложении." : "Это личное приложение. Доступ для этого аккаунта пока закрыт.",
        ...(allowed ? { reply_markup: { inline_keyboard: [[{ text: "Открыть монтаж", web_app: { url: config().appUrl } }]] } } : {}) };
      store.db.prepare("INSERT INTO telegram_replies(update_id,payload) VALUES(?,?)").run(String(update.update_id), JSON.stringify(reply));
    }
  });
  return { ok: true };
}
export async function flushOutbox(store: Store) {
  const replies = store.db.prepare("SELECT * FROM telegram_replies WHERE state='pending' AND attempts<5 AND next_attempt_at<? LIMIT 5").all(Date.now()) as { update_id: string; payload: string; attempts: number }[];
  for (const row of replies) {
    try { await telegram("sendMessage", JSON.parse(row.payload)); store.db.prepare("UPDATE telegram_replies SET state='sent' WHERE update_id=?").run(row.update_id); }
    catch { store.db.prepare("UPDATE telegram_replies SET attempts=attempts+1,next_attempt_at=? WHERE update_id=?").run(Date.now() + 5000 * 2 ** row.attempts, row.update_id); }
  }
  const rows = store.db.prepare("SELECT * FROM outbox WHERE state='pending' AND attempts<5 AND next_attempt_at<? LIMIT 5").all(Date.now()) as { id: string; job_id: string; payload: string; attempts: number }[];
  for (const row of rows) {
    try {
      store.job(row.job_id);
      const payload = JSON.parse(row.payload);
      const result = await telegram("sendMessage", { chat_id: payload.ownerId, text: payload.text,
        reply_markup: { inline_keyboard: [[{ text: "Открыть ролик", web_app: { url: `${config().appUrl}/?job=${row.job_id}` } }]] } });
      store.db.prepare("UPDATE outbox SET state='sent',telegram_message_id=? WHERE id=? AND state='pending'").run(String(result.message_id), row.id);
    } catch { store.db.prepare("UPDATE outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?").run(Date.now() + Math.min(300000, 5000 * 2 ** row.attempts), row.id); }
  }
}
