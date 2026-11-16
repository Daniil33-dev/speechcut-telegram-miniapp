import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveVideo } from "../src/components/save-video";
import { isDesktopSaveDevice, prepareShareFile, nativeDownload, SHARE_MEMORY_LIMIT, type TelegramWebApp } from "../src/client/save-video";
import { signAsset, verifyAssetSignature } from "../src/server/storage";

test("saving offers one action and no link that can navigate the Mini App to MP4", () => {
  const html = renderToStaticMarkup(createElement(SaveVideo, { url: "https://app.test/media/video", downloadUrl: "https://app.test/media/video?download=1", bytes: 123 }));
  assert.equal((html.match(/<button/g) || []).length, 1); assert.ok(html.includes("Подготовить сохранение"));
  assert.equal(/<a\b|href=|Скачать в/.test(html), false);
});
test("share preparation creates the complete original MP4 File and rejects partial or wrong content", async () => {
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  const fetcher = (async () => new Response(bytes, { headers: { "content-type": "video/mp4" } })) as typeof fetch;
  const file = await prepareShareFile("https://app.test/media/video", bytes.length, new AbortController().signal, () => {}, fetcher);
  assert.equal(file.name, "video.mp4"); assert.equal(file.type, "video/mp4");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  await assert.rejects(prepareShareFile("https://app.test/media/video", bytes.length + 1, new AbortController().signal, () => {}, fetcher), /не полностью/);
  await assert.rejects(prepareShareFile("https://app.test/media/video", bytes.length, new AbortController().signal, () => {}, (async () => new Response("error", { headers: { "content-type": "text/html" } })) as typeof fetch), /другой тип/);
  let fetched = false;
  await assert.rejects(prepareShareFile("https://app.test/media/video", SHARE_MEMORY_LIMIT + 1, new AbortController().signal, () => {}, (async () => { fetched = true; return new Response(); }) as typeof fetch));
  assert.equal(fetched, false);
});
test("native download uses Telegram popup; cancellation returns without a navigation fallback", async () => {
  const calls: { url: string; file_name: string }[] = [];
  const app: TelegramWebApp = { initData: "", ready() {}, expand() {}, openLink() { throw new Error("Must not open a link"); }, isVersionAtLeast: () => true,
    downloadFile(params, callback) { calls.push(params); callback?.(false); } };
  assert.equal(await nativeDownload(app, "https://app.test/media/video?download=1"), false);
  assert.deepEqual(calls, [{ url: "https://app.test/media/video?download=1", file_name: "video.mp4" }]);
  app.downloadFile = (_params, callback) => callback?.(true);
  assert.equal(await nativeDownload(app, "https://app.test/media/video?download=1"), true);
  app.isVersionAtLeast = () => false;
  await assert.rejects(nativeDownload(app, "https://app.test/media/video?download=1"), /недоступно/);
});
test("inline media signatures cannot be repurposed into attachment downloads", () => {
  const previous = process.env.MEDIA_SIGNING_SECRET; process.env.MEDIA_SIGNING_SECRET = "save-test-only-signing-key";
  try {
    const params = new URLSearchParams(signAsset("asset", "download"));
    verifyAssetSignature("asset", "download", params);
    assert.throws(() => verifyAssetSignature("asset", "media", params));
    assert.throws(() => verifyAssetSignature("asset", "download", new URLSearchParams(signAsset("asset", "media"))));
  } finally { if (previous === undefined) delete process.env.MEDIA_SIGNING_SECRET; else process.env.MEDIA_SIGNING_SECRET = previous; }
});
test("desktop uses downloading even with Web Share; phones and desktop-style iPad preserve sharing", () => {
  assert.equal(isDesktopSaveDevice("macos", "Mozilla/5.0 Macintosh"), true);
  assert.equal(isDesktopSaveDevice("tdesktop", "Mozilla/5.0 Windows"), true);
  assert.equal(isDesktopSaveDevice("ios", "Mozilla/5.0 Macintosh", 5), false);
  assert.equal(isDesktopSaveDevice("android", "Mozilla/5.0 Android"), false);
  assert.equal(isDesktopSaveDevice("weba", "Mozilla/5.0 Macintosh", 5), false);
  assert.equal(isDesktopSaveDevice("weba", "Mozilla/5.0 Macintosh", 0), true);
});
