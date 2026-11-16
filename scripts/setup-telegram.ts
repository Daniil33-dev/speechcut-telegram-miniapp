// Local setup only: token never enters chat, a URL, logs or the public Mini App.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { lstat, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const origin = "http://127.0.0.1:3079";
await mkdir(".local", { recursive: true, mode: 0o700 });
const sessionPath = resolve(".local/telegram-setup-session.json");
const savedSession = JSON.parse(await readFile(sessionPath, "utf8").catch(() => "null"));
const csrf = /^[a-f0-9]{48}$/.test(savedSession?.csrf || "") ? savedSession.csrf : randomBytes(24).toString("hex");
const nonce = /^[a-f0-9]{32}$/.test(savedSession?.nonce || "") ? savedSession.nonce : randomBytes(16).toString("hex");
await writeFile(sessionPath, JSON.stringify({ csrf, nonce }), { mode: 0o600 });
let token = "", username = "", owner = "";
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
async function save(values: Record<string, string>) {
  const path = resolve(".env.local"), info = await lstat(path).catch(() => null);
  if (info && !info.isFile()) throw new Error("Небезопасный путь конфигурации.");
  let text = info ? await readFile(path, "utf8") : "";
  for (const [key, value] of Object.entries(values)) { text = text.replace(new RegExp(`^${key}=.*\\n?`, "gm"), ""); text += (text && !text.endsWith("\n") ? "\n" : "") + `${key}=${value}\n`; }
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`; await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, path);
}
async function call(method: string, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); if (!response.ok || !result.ok) throw new Error("Telegram не принял запрос. Проверьте токен нового бота."); return result.result;
}
// Resume this application's saved bot after a helper restart. Never read any
// credentials from another project or echo the token into the returned HTML.
const existingEnv = await readFile(resolve(".env.local"), "utf8").catch(() => "");
token = existingEnv.match(/^BOT_TOKEN=(\S+)$/m)?.[1] || "";
if (token) { try { const me = await call("getMe"); username = me.username; owner = existingEnv.match(/^ALLOWED_TELEGRAM_USER_IDS=(\d+)$/m)?.[1] || ""; } catch { token = ""; } }
const submitScript = `<script>document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');const note=document.getElementById('setup-message');button.disabled=true;note.textContent='Проверяем подключение…';try{const response=await fetch(form.action,{method:'POST',body:new URLSearchParams(new FormData(form))});if(response.ok){location.href='/';return;}const text=await response.text();const documentResult=new DOMParser().parseFromString(text,'text/html');note.textContent=response.status===403?'Сессия формы обновилась. Обновите страницу и повторите подключение.':(documentResult.body.textContent||'Не удалось подключить бота.');}catch{note.textContent='Не удалось обратиться к форме. Обновите страницу и повторите.';}finally{button.disabled=false;}}));</script>`;
createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
  if (req.headers.host !== "127.0.0.1:3079") { res.writeHead(403).end(); return; }
  try {
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключение Telegram</title><style>body{font:18px/1.5 system-ui;max-width:620px;margin:40px auto;padding:20px}input,button{font:inherit;padding:14px;width:100%;box-sizing:border-box;margin:12px 0}a{color:#226558}</style><h1>Подключите нового бота</h1><p>В <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a> отправьте /newbot и создайте бота. Имя можно выбрать «Монтаж речи».</p>${owner ? `<p>Бот @${escape(username)} подключён. Личный доступ сохранён. Токен не показан.</p>` : username ? `<p>Бот @${escape(username)} проверен.</p><p><a href="https://t.me/${escape(username)}?start=setup_${nonce}" target="_blank" rel="noreferrer">Откройте бота и нажмите «Запустить»</a></p><form method="post" action="/owner"><input type="hidden" name="csrf" value="${csrf}"><button>Я нажал «Запустить» — определить личный доступ</button></form>` : `<form method="post" action="/bot"><label>Токен нового бота<input name="token" type="password" autocomplete="off" required></label><input type="hidden" name="csrf" value="${csrf}"><p>Нажатие сохранит BOT_TOKEN в ${escape(resolve(".env.local"))}. Бот с уже настроенным webhook не будет принят.</p><button>Проверить и сохранить токен</button></form>`}<p id="setup-message" role="status" aria-live="polite"></p>${submitScript}</html>`); return;
    }
    if (req.method !== "POST" || req.headers.origin !== origin) { res.writeHead(403).end(); return; }
    let text = ""; for await (const chunk of req) { text += chunk.toString(); if (text.length > 4096) throw new Error("Слишком большой запрос."); }
    const form = new URLSearchParams(text); if (form.get("csrf") !== csrf) { res.writeHead(403).end(); return; }
    if (req.url === "/bot") {
      const supplied = form.get("token")?.trim() || "";
      if (!/^\d{5,16}:[A-Za-z0-9_-]{20,100}$/.test(supplied)) throw new Error("Проверьте формат токена.");
      token = supplied; const me = await call("getMe"), hook = await call("getWebhookInfo");
      if (hook.url) { token = ""; throw new Error("У этого бота уже есть webhook. Используйте нового бота, чтобы сохранить прежнее приложение."); }
      await save({ BOT_TOKEN: token }); username = me.username;
    } else if (req.url === "/owner") {
      if (!token || !username) throw new Error("Сначала сохраните токен.");
      const updates = await call("getUpdates", { limit: 100, timeout: 0 });
      const update = updates.find((u: { message?: { text?: string } }) => u.message?.text === `/start setup_${nonce}`);
      if (!update || !Number.isSafeInteger(update.message.from?.id)) throw new Error("Сообщение ещё не найдено. Откройте ссылку на бота и нажмите «Запустить», затем повторите.");
      owner = String(update.message.from.id); await save({ ALLOWED_TELEGRAM_USER_IDS: owner });
    } else { res.writeHead(404).end(); return; }
    res.writeHead(303, { Location: "/" }).end();
  } catch (error) { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.writeHead(422).end(`<p>${escape(error instanceof Error ? error.message : "Не удалось подключить бота.")}</p><a href="/">Вернуться</a>`); }
}).listen(3079, "127.0.0.1", () => console.log("Telegram setup form: http://127.0.0.1:3079 (local Mac only)"));
