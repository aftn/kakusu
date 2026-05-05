import {
  TEXT_PREVIEW_LIMIT_MESSAGE,
  getMimeType,
  getPreviewType,
  isHtmlFile,
  isMarkdownFile,
  isPreviewable,
  renderMarkdownPreview,
} from "@/utils/preview";
import { describe, expect, it } from "vitest";

describe("preview helpers", () => {
  it("detects html and markdown extensions", () => {
    expect(isHtmlFile("index.html")).toBe(true);
    expect(isHtmlFile("index.htm")).toBe(true);
    expect(isHtmlFile("note.md")).toBe(false);
    expect(isMarkdownFile("note.md")).toBe(true);
    expect(isMarkdownFile("note.markdown")).toBe(true);
    expect(isMarkdownFile("note.txt")).toBe(false);
  });

  it("renders markdown with a restrictive CSP document", () => {
    const rendered = renderMarkdownPreview("# Title\n\nBody");
    expect(rendered).toContain("default-src 'none'");
    expect(rendered).toContain("<h1");
    expect(rendered).toContain("Title");
  });

  it("escapes dangerous markdown link attributes", () => {
    const rendered = renderMarkdownPreview(
      '[x](https://example.com" onclick="alert(1))',
    );
    expect(rendered).not.toContain('onclick="alert(1)"');
    expect(rendered).toContain("https://example.com");
  });

  it("exposes a stable large-text warning", () => {
    expect(TEXT_PREVIEW_LIMIT_MESSAGE).toContain("1MB");
  });

  it("supports common browser-preview video extensions", () => {
    expect(isPreviewable("clip.mp4")).toBe(true);
    expect(isPreviewable("clip.m4v")).toBe(true);
    expect(isPreviewable("clip.mov")).toBe(true);
    expect(getPreviewType("clip.mov")).toBe("video");
    expect(getMimeType("clip.mov")).toBe("video/quicktime");
  });
});
