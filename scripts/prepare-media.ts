import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.env.MEDIA_TOOLS_DIR || ".local/models");
await mkdir(root, { recursive: true, mode: 0o700 });
const target = join(root, "silero-v5.1.2.onnx"), expected = "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";
let bytes = await readFile(target).catch(() => null);
if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
  const response = await fetch("https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx");
  if (!response.ok) throw new Error("Silero download failed"); bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Silero checksum mismatch");
  await writeFile(target, bytes, { mode: 0o600 });
}
const license = await fetch("https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/LICENSE");
if (!license.ok) throw new Error("Silero license download failed");
await writeFile(join(root, "LICENSE-Silero.txt"), await license.text());
await mkdir("public/fonts", { recursive: true });
if (!(await readFile("public/fonts/DejaVuSans-Bold.ttf").catch(() => null))) await copyFile("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "public/fonts/DejaVuSans-Bold.ttf");
console.log("Silero v5.1.2 verified. Set VAD_MODEL_PATH to the model location and FONT_PATH to DejaVuSans-Bold.ttf.");
