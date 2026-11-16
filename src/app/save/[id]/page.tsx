import { Store } from "@/server/store";
import { verifyAssetSignature, signAsset } from "@/server/storage";
import { SaveVideo } from "@/components/save-video";
export const dynamic = "force-dynamic";
export default async function SavePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  try {
    const { id } = await params, query = await searchParams;
    verifyAssetSignature(id, "save", new URLSearchParams({ expires: String(query.expires || ""), sig: String(query.sig || "") }));
    const store = new Store(), artifact = store.artifact(id), asset = store.asset(artifact.outputAssetId, artifact.jobId);
    const url = `/media/${asset.id}?${signAsset(asset.id, "media")}`;
    const downloadUrl = `/media/${asset.id}?download=1&${signAsset(asset.id, "download")}`;
    return <main className="app-shell"><h1>Сохраните видео</h1><video className="video-player" src={url} controls controlsList="nodownload" playsInline preload="metadata" /><SaveVideo url={url} downloadUrl={downloadUrl} bytes={asset.bytes} /></main>;
  } catch { return <main className="app-shell"><h1>Ссылка недоступна</h1><p>Откройте готовый ролик в Mini App и обновите ссылку. Повторно собирать видео не нужно.</p></main>; }
}
