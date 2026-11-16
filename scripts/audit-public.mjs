// No external service: checks publishable files without printing matching secrets.
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = resolve(process.argv[2] || ".");
const skip = new Set(["node_modules", ".next", ".git", ".local", ".tools"]);
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name === ".env.local" || entry.name.endsWith(".tsbuildinfo")) continue;
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not publishable: ${relative(root, path)}`);
    if (entry.isDirectory()) await walk(path); else files.push(path);
  }
}
let ownGit = false;
try { ownGit = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === root; } catch {}
if (ownGit) {
  const names = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  files.push(...names.map(name => resolve(root, name)));
} else await walk(root);
const findings = [];
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["provider token", /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{24,}\b/],
  ["Telegram token", /\b\d{5,16}:[A-Za-z0-9_-]{30,}\b/],
  ["personal home path", /\/(?:Users|home)\/[A-Za-zА-Яа-я0-9_.-]+\//],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i]
];
for (const path of files) {
  const name = relative(root, path);
  if (/(?:^|\/)(?:\.env(?!\.example$)[^/]*|id_(?:rsa|ed25519)[^/]*|known_hosts|[^/]+\.(?:sqlite(?:-wal|-shm)?|db|pem|key|mp4|mov|webm|mkv|log))$/i.test(name)) {
    findings.push(`${name}: private/runtime file`); continue;
  }
  if (extname(path) === ".ttf") continue;
  const text = await readFile(path, "utf8");
  for (const [label, pattern] of rules) {
    if (label === "email address" && name === "public/fonts/LICENSE-DejaVu.txt") continue;
    if (pattern.test(text)) findings.push(`${name}: ${label}`);
  }
  if (extname(path) === ".md") {
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1];
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const target = decodeURIComponent(link.split("#")[0]);
      if (!existsSync(resolve(path, "..", target))) findings.push(`${name}: broken local link ${target}`);
    }
  }
}
if (findings.length) {
  console.error(findings.join("\n")); process.exitCode = 1;
} else console.log(`Public audit passed: ${files.length} files; no matching secrets/private paths or broken local links.`);
