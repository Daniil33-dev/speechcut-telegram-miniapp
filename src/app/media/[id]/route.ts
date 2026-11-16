import { Store } from "@/server/store";
import { verifyAssetSignature, streamAsset } from "@/server/storage";
import { AppError } from "@/core/domain";
import { config } from "@/server/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams, attachment = params.get("download") === "1";
    verifyAssetSignature(id, attachment ? "download" : "media", params);
    const store = new Store(), asset = store.asset(id); store.job(asset.jobId);
    // Old cached download links must not replace the Mini App with a media document.
    // Video elements/fetch still receive the stream; native downloads use their
    // separately signed attachment URL.
    if (!attachment && request.headers.get("sec-fetch-dest") === "document")
      return Response.redirect(`${config().appUrl}/?job=${asset.jobId}`, 303);
    return await streamAsset(asset, request, attachment);
  } catch (error) { const e = error instanceof AppError ? error : new AppError("NOT_FOUND", "Файл не найден.", 404); return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status, headers: { "Cache-Control": "no-store" } }); }
}
export { handle as GET, handle as HEAD };
