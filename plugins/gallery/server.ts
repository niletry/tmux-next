import {
  listGallery,
  galleryFilePath,
  saveGalleryUpload,
  MAX_GALLERY_UPLOAD_BYTES,
} from "./gallery";

/**
 * 放文件的那个抽屉：里面有什么，以及一个个把文件取出来。名字被收窄成制品库内
 * 的 basename，所以它永远够不到磁盘上别的地方。content-type 由 Bun.file 按扩展
 * 名给，这才让客户端能直接渲染图片和 HTML。
 */
export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/gallery" && req.method === "GET") {
    return Response.json(await listGallery());
  }
  if (url.pathname === "/api/gallery/file" && req.method === "GET") {
    const path = galleryFilePath(url.searchParams.get("name") ?? "");
    if (!path) return new Response("bad name", { status: 400 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  }
  if (url.pathname === "/api/gallery/file" && req.method === "POST") {
    // 先按声明的长度拒掉，超大的 body 根本到不了 formData()；解析后那道检查仍然守着。
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_GALLERY_UPLOAD_BYTES) {
      return new Response("too big", { status: 413 });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return new Response("bad form", { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) return new Response("missing file", { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return new Response("empty", { status: 400 });
    if (bytes.byteLength > MAX_GALLERY_UPLOAD_BYTES) {
      return new Response("too big", { status: 413 });
    }
    const name = await saveGalleryUpload(file.name, bytes);
    if (!name) return new Response("bad name", { status: 400 });
    return Response.json({ name });
  }
  return null;
}
