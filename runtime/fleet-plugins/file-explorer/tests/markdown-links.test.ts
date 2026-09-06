import { describe, expect, it } from "vitest";

import {
  buildFileExplorerImageSrc,
  isAllowedExternalMarkdownImageSrc,
  isSupportedMarkdownImagePath,
  resolveMarkdownFileRef,
} from "../client/viewer/markdown-links.js";
import { cacheBustedImageSrc } from "../client/viewer/image.js";

describe("file explorer markdown links", () => {

  it("외부 링크와 root 밖으로 나가는 링크는 내부 파일 링크로 바꾸지 않는다", () => {
    expect(resolveMarkdownFileRef("https://example.com/badge.svg", "README.md")).toBeNull();
    expect(resolveMarkdownFileRef("//example.com/badge.svg", "README.md")).toBeNull();
    expect(resolveMarkdownFileRef("../../etc/passwd", "README.md")).toBeNull();
    expect(resolveMarkdownFileRef("#quick-start", "README.md")).toBeNull();
  });

  it("image route는 same-origin plugin 경로와 인코딩된 Theater/path query만 만든다", () => {
    expect(buildFileExplorerImageSrc("abc 123", ".github/logo.png")).toBe(
      "/plugins/file-explorer/files/image?theaterId=abc%20123&path=.github%2Flogo.png",
    );
  });

  it("README badge용 shields.io HTTPS 이미지만 외부 auto-fetch를 허용한다", () => {
    expect(isAllowedExternalMarkdownImageSrc("https://img.shields.io/npm/v/@dotobokuri/fleet-cli?color=blue")).toBe(true);
    expect(isAllowedExternalMarkdownImageSrc("http://img.shields.io/npm/v/pkg")).toBe(false);
    expect(isAllowedExternalMarkdownImageSrc("https://example.com/tracker.png")).toBe(false);
  });
});
