import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const vps = process.argv.includes("--vps");
const target = resolve(process.argv.slice(2).find(a => !a.startsWith("--")) || ".env.local");
let text = await readFile(resolve(".env.example"), "utf8");
const values: Record<string, string> = {
  TELEGRAM_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  MEDIA_SIGNING_SECRET: randomBytes(32).toString("hex"),
  FONT_PATH: resolve("public/fonts/DejaVuSans-Bold.ttf"),
  VAD_MODEL_PATH: vps ? "/var/lib/speechcut/models/silero-v5.1.2.onnx" : resolve(".local/models/silero-v5.1.2.onnx")
};
if (vps) Object.assign(values, {
  APP_URL: "https://editor.example.com", DATA_DIR: "/var/lib/speechcut/data",
  SQLITE_PATH: "/var/lib/speechcut/data/editor.sqlite", NODE_ENV: "production",
  FONT_PATH: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
});
for (const [name, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${name}=.*$`, "m");
  text = pattern.test(text) ? text.replace(pattern, `${name}=${value}`) : `${text}\n${name}=${value}\n`;
}
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
try { await writeFile(target, text, { flag: "wx", mode: 0o600 }); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    console.log("Configuration already exists; preserved without changes.");
    process.exit(0);
  }
  throw error;
}
console.log("Created private environment template with unique signing secrets. Fill account settings in your editor; values are not printed.");
