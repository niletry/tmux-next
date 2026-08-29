// @ts-check
/**
 * 制品库的清单。纯数据——服务端在 plugins/gallery/server.ts。
 *
 * 浏览器会 import 这个文件（i18n.js 和 nav.js 都要），所以这里不能引任何 .ts。
 */

/** @type {import("../types").Plugin} */
export default {
  id: "gallery",
  titleKey: "gallery.title",
  icon:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  i18n: {
    zh: {
      "gallery.title": "制品",
      "gallery.loadFailed": "加载失败",
      "gallery.count": "{n} 项",
      "gallery.empty": "还没有制品",
      "gallery.emptyHint": "把图片 / HTML / SVG 放进",
      "gallery.prev": "上一个",
      "gallery.next": "下一个",
      "gallery.close": "‹ 关闭",
      "gallery.download": "下载",
      "gallery.noPreview": "这个类型不支持预览，点右上「下载」查看。",
      "gallery.file": "文件",
      "gallery.upload": "上传",
      "gallery.uploading": "正在上传 {n} 个文件…",
      "gallery.uploaded": "已上传 {n} 个文件",
      "gallery.uploadPartial": "已上传 {n} 个，部分失败",
      "gallery.uploadTooBig": "文件太大，单个不能超过 {mb}MB",
      "gallery.uploadFailed": "上传失败",
    },
    en: {
      "gallery.title": "Artifacts",
      "gallery.loadFailed": "Could not load",
      "gallery.count": "{n}",
      "gallery.empty": "No artifacts yet",
      "gallery.emptyHint": "Drop images / HTML / SVG into",
      "gallery.prev": "Previous",
      "gallery.next": "Next",
      "gallery.close": "‹ Close",
      "gallery.download": "Download",
      "gallery.noPreview": "This type cannot be previewed — use Download at the top right.",
      "gallery.file": "file",
      "gallery.upload": "Upload",
      "gallery.uploading": "Uploading {n} files…",
      "gallery.uploaded": "Uploaded {n} files",
      "gallery.uploadPartial": "Uploaded {n}, some failed",
      "gallery.uploadTooBig": "File too large — max {mb}MB each",
      "gallery.uploadFailed": "Upload failed",
    },
  },
};
