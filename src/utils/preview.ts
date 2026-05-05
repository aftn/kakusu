const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "weba"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "ogv"]);
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "xml",
  "csv",
  "log",
  "ini",
  "cfg",
  "conf",
  "yaml",
  "yml",
  "toml",
  "js",
  "ts",
  "jsx",
  "tsx",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "py",
  "rb",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "go",
  "rs",
  "swift",
  "sh",
  "bash",
  "zsh",
  "bat",
  "ps1",
  "sql",
  "graphql",
  "gql",
  "env",
  "gitignore",
  "dockerignore",
  "editorconfig",
]);

/** Linear-time inline Markdown parser (bold, italic, bold+italic).
 *  Replaces regex-based replacement to avoid theoretical ReDoS. */
function parseInlineMarkdown(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "*") {
      if (text[i + 1] === "*" && text[i + 2] === "*") {
        const end = text.indexOf("***", i + 3);
        if (end !== -1) {
          result += `<strong><em>${text.slice(i + 3, end)}</em></strong>`;
          i = end + 3;
          continue;
        }
      } else if (text[i + 1] === "*") {
        const end = text.indexOf("**", i + 2);
        if (end !== -1) {
          result += `<strong>${text.slice(i + 2, end)}</strong>`;
          i = end + 2;
          continue;
        }
      } else {
        const end = text.indexOf("*", i + 1);
        if (end !== -1) {
          result += `<em>${text.slice(i + 1, end)}</em>`;
          i = end + 1;
          continue;
        }
      }
    }
    result += text[i];
    i++;
  }
  return result;
}
const PDF_EXTS = new Set(["pdf"]);

export const MAX_TEXT_PREVIEW_BYTES = 1_048_576;
export const TEXT_PREVIEW_LIMIT_MESSAGE =
  "テキストプレビューは 1MB までです。ダウンロードして確認してください。";

export const MAX_PREVIEW_FILE_BYTES = 200 * 1_048_576; // 200MB
export const PREVIEW_TOO_LARGE_MESSAGE =
  "ファイルが大きすぎるためプレビューできません（200MB超）。ダウンロードして確認してください。";

export function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isPreviewable(name: string): boolean {
  const ext = getFileExtension(name);
  return (
    IMAGE_EXTS.has(ext) ||
    AUDIO_EXTS.has(ext) ||
    VIDEO_EXTS.has(ext) ||
    TEXT_EXTS.has(ext) ||
    PDF_EXTS.has(ext)
  );
}

export type PreviewType = "image" | "audio" | "video" | "text" | "pdf" | null;

export function getPreviewType(name: string): PreviewType {
  const ext = getFileExtension(name);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (TEXT_EXTS.has(ext)) return "text";
  if (PDF_EXTS.has(ext)) return "pdf";
  return null;
}

const MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  weba: "audio/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  xml: "text/xml",
  csv: "text/csv",
  log: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  js: "text/javascript",
  ts: "text/typescript",
  jsx: "text/javascript",
  tsx: "text/typescript",
  css: "text/css",
  scss: "text/css",
  less: "text/css",
  html: "text/html",
  htm: "text/html",
  py: "text/x-python",
  rb: "text/x-ruby",
  java: "text/x-java",
  c: "text/x-c",
  cpp: "text/x-c++",
  h: "text/x-c",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  go: "text/x-go",
  rs: "text/x-rust",
  swift: "text/x-swift",
  sh: "text/x-sh",
  bash: "text/x-sh",
  zsh: "text/x-sh",
  bat: "text/plain",
  ps1: "text/plain",
  sql: "text/x-sql",
  graphql: "text/plain",
  gql: "text/plain",
  env: "text/plain",
  gitignore: "text/plain",
  dockerignore: "text/plain",
  editorconfig: "text/plain",
  pdf: "application/pdf",
};

export function getMimeType(name: string): string {
  return MIME_MAP[getFileExtension(name)] || "application/octet-stream";
}

export function isHtmlFile(name: string): boolean {
  const ext = getFileExtension(name);
  return ext === "html" || ext === "htm";
}

export function isMarkdownFile(name: string): boolean {
  const ext = getFileExtension(name);
  return ext === "md" || ext === "markdown";
}

import {
  MARKDOWN_PREVIEW_CODE_BLOCK_TOKEN_PREFIX,
  MARKDOWN_PREVIEW_INLINE_CODE_TOKEN_PREFIX,
} from "@/config/app";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** プレビュー用に最小限の Markdown を安全な HTML に変換する。 */
export function renderMarkdownPreview(src: string): string {
  let html = escapeHtml(src);
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  html = html.replace(/^```([\w-]*)\n([\s\S]*?)^```/gm, (_m, _lang, code) => {
    const token = `${MARKDOWN_PREVIEW_CODE_BLOCK_TOKEN_PREFIX}${codeBlocks.length}%%`;
    codeBlocks.push(
      `<pre style="background:#f3f4f6;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px"><code>${code.trimEnd()}</code></pre>`,
    );
    return token;
  });

  html = html.replace(/`([^`]+)`/g, (_m, code) => {
    const token = `${MARKDOWN_PREVIEW_INLINE_CODE_TOKEN_PREFIX}${inlineCodes.length}%%`;
    inlineCodes.push(
      `<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:0.9em">${code}</code>`,
    );
    return token;
  });

  html = html.replace(
    /^######\s+(.+)$/gm,
    '<h6 style="font-size:0.85em;font-weight:600;margin:0.8em 0 0.4em">$1</h6>',
  );
  html = html.replace(
    /^#####\s+(.+)$/gm,
    '<h5 style="font-size:0.9em;font-weight:600;margin:0.8em 0 0.4em">$1</h5>',
  );
  html = html.replace(
    /^####\s+(.+)$/gm,
    '<h4 style="font-size:1em;font-weight:600;margin:1em 0 0.4em">$1</h4>',
  );
  html = html.replace(
    /^###\s+(.+)$/gm,
    '<h3 style="font-size:1.1em;font-weight:600;margin:1em 0 0.4em">$1</h3>',
  );
  html = html.replace(
    /^##\s+(.+)$/gm,
    '<h2 style="font-size:1.3em;font-weight:600;margin:1.2em 0 0.4em">$1</h2>',
  );
  html = html.replace(
    /^#\s+(.+)$/gm,
    '<h1 style="font-size:1.6em;font-weight:700;margin:1.2em 0 0.5em">$1</h1>',
  );
  html = html.replace(
    /^---+$/gm,
    '<hr style="border:0;border-top:1px solid #e5e7eb;margin:1.2em 0">',
  );
  html = parseInlineMarkdown(html);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^")\s]+)\)/g,
    '<a href="$2" style="color:#2563eb;text-decoration:underline" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  html = html.replace(
    /^(?:- |\* )(.+)$/gm,
    '<li style="margin-left:1.5em;list-style:disc">$1</li>',
  );
  html = html.replace(
    /^&gt;\s?(.+)$/gm,
    '<blockquote style="border-left:3px solid #d1d5db;padding-left:12px;color:#6b7280;margin:0.5em 0">$1</blockquote>',
  );
  html = html.replace(/\n{2,}/g, '</p><p style="margin:0.6em 0">');
  html = html.replace(/\n/g, "<br>");

  html = html.replace(
    /%%KAKUSU_INLINE_CODE_(\d+)%%/g,
    (_m, index) => inlineCodes[Number(index)] ?? "",
  );
  html = html.replace(
    /%%KAKUSU_CODE_BLOCK_(\d+)%%/g,
    (_m, index) => codeBlocks[Number(index)] ?? "",
  );

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:"><meta name="referrer" content="no-referrer"></head><body style="margin:0;background:#fff"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#1f2937;max-width:720px;margin:0 auto;padding:16px"><p style="margin:0.6em 0">${html}</p></div></body></html>`;
}

/**
 * ダウンロード属性に安全に使えるようファイル名を整形する。
 * パス区切り文字、制御文字、危険なパターンを除去する。
 */
export function sanitizeFileName(name: string): string {
  // パス区切り文字と制御文字を除去する。
  let safe = "";
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (
      char === "\\" ||
      char === "/" ||
      char === ":" ||
      code < 32 ||
      code === 127
    ) {
      safe += "_";
    } else {
      safe += char;
    }
  }
  // 連続したアンダースコアをまとめる。
  safe = safe.replace(/_{2,}/g, "_");
  // 先頭のドットと末尾のドット・空白を除去する。
  safe = safe.replace(/^\.+/, "").replace(/[\s.]+$/, "");
  return safe || "download";
}
