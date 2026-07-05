import { describe, expect, it } from "vitest";

import {
  buildFileExplorerImageSrc,
  isAllowedExternalMarkdownImageSrc,
  isSupportedMarkdownImagePath,
  resolveMarkdownFileRef,
} from "../client/viewer/markdown-links.js";

describe("file explorer markdown links", () => {
  it("README 기준 상대 이미지 경로를 Theater 내부 경로로 해석한다", () => {
    expect(resolveMarkdownFileRef(".github/logo.png", "README.md")).toBe(".github/logo.png");
    expect(resolveMarkdownFileRef("./docs/fleet-development-reference.md", "README.md")).toBe("docs/fleet-development-reference.md");
  });

  it("하위 문서의 상대 링크를 현재 문서 위치 기준으로 정규화한다", () => {
    expect(resolveMarkdownFileRef("../assets/logo.png", "docs/guides/README.md")).toBe("docs/assets/logo.png");
    expect(resolveMarkdownFileRef("./setup.md#install", "docs/guides/README.md")).toBe("docs/guides/setup.md");
  });

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

  it("서버 이미지 allowlist와 맞는 markdown image 확장자만 지원한다", () => {
    expect(isSupportedMarkdownImagePath(".github/logo.png")).toBe(true);
    expect(isSupportedMarkdownImagePath(".github/fleet-harness.gif")).toBe(true);
    expect(isSupportedMarkdownImagePath(".github/logo.svg")).toBe(false);
  });

  it("README badge용 shields.io HTTPS 이미지만 외부 auto-fetch를 허용한다", () => {
    expect(isAllowedExternalMarkdownImageSrc("https://img.shields.io/npm/v/@dotobokuri/fleet-cli?color=blue")).toBe(true);
    expect(isAllowedExternalMarkdownImageSrc("http://img.shields.io/npm/v/pkg")).toBe(false);
    expect(isAllowedExternalMarkdownImageSrc("https://example.com/tracker.png")).toBe(false);
  });
});
