import type { ReactElement } from "react";

// 파일 확장자/이름을 다채로운 컬러 아이콘으로 매핑하는 모듈.
// 각 아이콘은 단색(currentColor) SVG이며, 색은 explorer.css의 --fexp-ic-* 토큰에서 온다.
// 토큰은 maritime/carbon 테마별로 재정의되므로 아이콘 팔레트가 테마에 맞춰 자동 전환된다.

type ShapeKey =
  | "angle"
  | "braces"
  | "hash"
  | "doc"
  | "image"
  | "terminal"
  | "gear"
  | "markup"
  | "database"
  | "archive"
  | "chip"
  | "default"
  | "folderClosed"
  | "folderOpen";

interface IconSpec {
  readonly shape: ShapeKey;
  readonly tone: string;
}

interface FileIconProps {
  readonly name: string;
}

interface FolderIconProps {
  readonly name: string;
  readonly open: boolean;
}

// ── 색 토큰(축약) ── explorer.css의 --fexp-ic-<tone> 변수명과 1:1 대응
const TONE = {
  ts: "ts",
  js: "js",
  json: "json",
  css: "css",
  html: "html",
  md: "md",
  py: "py",
  go: "go",
  rust: "rust",
  shell: "shell",
  config: "config",
  image: "image",
  data: "data",
  archive: "archive",
  binary: "binary",
  ruby: "ruby",
  folder: "folder",
  default: "default",
} as const;

// ── 특수 폴더 → 색 토큰 ── 보편적으로 인지되는 폴더만 강조, 나머지는 차분한 기본 폴더색
const SPECIAL_FOLDERS: Readonly<Record<string, string>> = {
  src: TONE.ts,
  lib: TONE.ts,
  app: TONE.ts,
  test: TONE.shell,
  tests: TONE.shell,
  __tests__: TONE.shell,
  spec: TONE.shell,
  specs: TONE.shell,
  node_modules: TONE.binary,
  vendor: TONE.binary,
  dist: TONE.config,
  build: TONE.config,
  out: TONE.config,
  target: TONE.config,
  docs: TONE.md,
  doc: TONE.md,
  public: TONE.data,
  assets: TONE.data,
  static: TONE.data,
  components: TONE.image,
  scripts: TONE.js,
  styles: TONE.css,
  ".git": TONE.html,
  ".github": TONE.config,
  ".vscode": TONE.css,
};

// ── 확장자 → 아이콘 스펙 ──
const EXT_SPECS: Readonly<Record<string, IconSpec>> = {
  // TypeScript / JavaScript
  ts: { shape: "angle", tone: TONE.ts },
  tsx: { shape: "angle", tone: TONE.ts },
  mts: { shape: "angle", tone: TONE.ts },
  cts: { shape: "angle", tone: TONE.ts },
  "d.ts": { shape: "angle", tone: TONE.ts },
  js: { shape: "angle", tone: TONE.js },
  jsx: { shape: "angle", tone: TONE.js },
  mjs: { shape: "angle", tone: TONE.js },
  cjs: { shape: "angle", tone: TONE.js },
  // 데이터/직렬화
  json: { shape: "braces", tone: TONE.json },
  jsonc: { shape: "braces", tone: TONE.json },
  json5: { shape: "braces", tone: TONE.json },
  jsonl: { shape: "braces", tone: TONE.json },
  graphql: { shape: "braces", tone: TONE.image },
  gql: { shape: "braces", tone: TONE.image },
  proto: { shape: "braces", tone: TONE.go },
  // 스타일
  css: { shape: "hash", tone: TONE.css },
  scss: { shape: "hash", tone: TONE.css },
  sass: { shape: "hash", tone: TONE.css },
  less: { shape: "hash", tone: TONE.css },
  styl: { shape: "hash", tone: TONE.css },
  // 마크업
  html: { shape: "markup", tone: TONE.html },
  htm: { shape: "markup", tone: TONE.html },
  xml: { shape: "markup", tone: TONE.html },
  xhtml: { shape: "markup", tone: TONE.html },
  vue: { shape: "markup", tone: TONE.shell },
  svelte: { shape: "markup", tone: TONE.rust },
  astro: { shape: "markup", tone: TONE.image },
  // 문서
  md: { shape: "doc", tone: TONE.md },
  mdx: { shape: "doc", tone: TONE.md },
  markdown: { shape: "doc", tone: TONE.md },
  rst: { shape: "doc", tone: TONE.md },
  txt: { shape: "doc", tone: TONE.default },
  text: { shape: "doc", tone: TONE.default },
  log: { shape: "doc", tone: TONE.default },
  adoc: { shape: "doc", tone: TONE.md },
  pdf: { shape: "doc", tone: TONE.ruby },
  // 언어
  py: { shape: "angle", tone: TONE.py },
  pyi: { shape: "angle", tone: TONE.py },
  pyw: { shape: "angle", tone: TONE.py },
  go: { shape: "angle", tone: TONE.go },
  rs: { shape: "angle", tone: TONE.rust },
  rb: { shape: "angle", tone: TONE.ruby },
  rake: { shape: "angle", tone: TONE.ruby },
  gemspec: { shape: "angle", tone: TONE.ruby },
  java: { shape: "angle", tone: TONE.html },
  kt: { shape: "angle", tone: TONE.config },
  kts: { shape: "angle", tone: TONE.config },
  scala: { shape: "angle", tone: TONE.ruby },
  c: { shape: "angle", tone: TONE.ts },
  h: { shape: "angle", tone: TONE.ts },
  cpp: { shape: "angle", tone: TONE.css },
  cc: { shape: "angle", tone: TONE.css },
  cxx: { shape: "angle", tone: TONE.css },
  hpp: { shape: "angle", tone: TONE.css },
  cs: { shape: "angle", tone: TONE.config },
  php: { shape: "angle", tone: TONE.config },
  swift: { shape: "angle", tone: TONE.html },
  lua: { shape: "angle", tone: TONE.ts },
  dart: { shape: "angle", tone: TONE.go },
  // 셸/스크립트
  sh: { shape: "terminal", tone: TONE.shell },
  bash: { shape: "terminal", tone: TONE.shell },
  zsh: { shape: "terminal", tone: TONE.shell },
  fish: { shape: "terminal", tone: TONE.shell },
  ps1: { shape: "terminal", tone: TONE.css },
  bat: { shape: "terminal", tone: TONE.shell },
  cmd: { shape: "terminal", tone: TONE.shell },
  // 설정
  yaml: { shape: "gear", tone: TONE.config },
  yml: { shape: "gear", tone: TONE.config },
  toml: { shape: "gear", tone: TONE.config },
  ini: { shape: "gear", tone: TONE.config },
  conf: { shape: "gear", tone: TONE.config },
  cfg: { shape: "gear", tone: TONE.config },
  properties: { shape: "gear", tone: TONE.config },
  env: { shape: "gear", tone: TONE.config },
  editorconfig: { shape: "gear", tone: TONE.config },
  // 이미지
  png: { shape: "image", tone: TONE.image },
  jpg: { shape: "image", tone: TONE.image },
  jpeg: { shape: "image", tone: TONE.image },
  gif: { shape: "image", tone: TONE.image },
  webp: { shape: "image", tone: TONE.image },
  svg: { shape: "image", tone: TONE.image },
  ico: { shape: "image", tone: TONE.image },
  bmp: { shape: "image", tone: TONE.image },
  avif: { shape: "image", tone: TONE.image },
  tiff: { shape: "image", tone: TONE.image },
  heic: { shape: "image", tone: TONE.image },
  // 미디어
  mp4: { shape: "image", tone: TONE.data },
  mov: { shape: "image", tone: TONE.data },
  webm: { shape: "image", tone: TONE.data },
  mkv: { shape: "image", tone: TONE.data },
  mp3: { shape: "chip", tone: TONE.shell },
  wav: { shape: "chip", tone: TONE.shell },
  flac: { shape: "chip", tone: TONE.shell },
  ogg: { shape: "chip", tone: TONE.shell },
  // 데이터/DB
  sql: { shape: "database", tone: TONE.data },
  csv: { shape: "database", tone: TONE.data },
  tsv: { shape: "database", tone: TONE.data },
  db: { shape: "database", tone: TONE.data },
  sqlite: { shape: "database", tone: TONE.data },
  sqlite3: { shape: "database", tone: TONE.data },
  parquet: { shape: "database", tone: TONE.data },
  // 아카이브
  zip: { shape: "archive", tone: TONE.archive },
  tar: { shape: "archive", tone: TONE.archive },
  gz: { shape: "archive", tone: TONE.archive },
  tgz: { shape: "archive", tone: TONE.archive },
  bz2: { shape: "archive", tone: TONE.archive },
  xz: { shape: "archive", tone: TONE.archive },
  rar: { shape: "archive", tone: TONE.archive },
  "7z": { shape: "archive", tone: TONE.archive },
  zst: { shape: "archive", tone: TONE.archive },
  // 바이너리/기타
  bin: { shape: "chip", tone: TONE.binary },
  exe: { shape: "chip", tone: TONE.binary },
  dll: { shape: "chip", tone: TONE.binary },
  so: { shape: "chip", tone: TONE.binary },
  dylib: { shape: "chip", tone: TONE.binary },
  wasm: { shape: "chip", tone: TONE.config },
  class: { shape: "chip", tone: TONE.binary },
  lock: { shape: "chip", tone: TONE.binary },
  woff: { shape: "chip", tone: TONE.config },
  woff2: { shape: "chip", tone: TONE.config },
  ttf: { shape: "chip", tone: TONE.config },
  otf: { shape: "chip", tone: TONE.config },
};

// ── 특수 파일명(확장자만으로 구분 안 되는 친숙한 파일) ──
const BASENAME_SPECS: Readonly<Record<string, IconSpec>> = {
  dockerfile: { shape: "chip", tone: TONE.css },
  "docker-compose.yml": { shape: "gear", tone: TONE.css },
  "docker-compose.yaml": { shape: "gear", tone: TONE.css },
  makefile: { shape: "gear", tone: TONE.html },
  "cmakelists.txt": { shape: "gear", tone: TONE.html },
  ".gitignore": { shape: "gear", tone: TONE.html },
  ".gitattributes": { shape: "gear", tone: TONE.html },
  ".dockerignore": { shape: "gear", tone: TONE.html },
  ".npmignore": { shape: "gear", tone: TONE.html },
  ".npmrc": { shape: "gear", tone: TONE.ruby },
  "package.json": { shape: "braces", tone: TONE.shell },
  "tsconfig.json": { shape: "braces", tone: TONE.ts },
  license: { shape: "doc", tone: TONE.json },
  "license.md": { shape: "doc", tone: TONE.json },
  licence: { shape: "doc", tone: TONE.json },
};

const DEFAULT_SPEC: IconSpec = { shape: "default", tone: TONE.default };

// ── 도형 정의(0 0 16 16 viewBox 기준) ── 메인 stroke + 저투명 fill로 두톤 깊이감
const SHAPES: Readonly<Record<ShapeKey, ReactElement>> = {
  angle: (
    <>
      <path d="M5.6 4.5 2.4 8l3.2 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.4 4.5 13.6 8l-3.2 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.1 3.4 6.9 12.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" />
    </>
  ),
  braces: (
    <>
      <path d="M6.4 3.4c-1.1 0-1.5.5-1.5 1.5v1.2c0 .9-.4 1.4-1.1 1.6v.6c.7.2 1.1.7 1.1 1.6v1.2c0 1 .4 1.5 1.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.6 3.4c1.1 0 1.5.5 1.5 1.5v1.2c0 .9.4 1.4 1.1 1.6v.6c-.7.2-1.1.7-1.1 1.6v1.2c0 1-.4 1.5-1.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="0.85" fill="currentColor" opacity="0.6" />
    </>
  ),
  hash: (
    <>
      <path d="M6.6 3 5.2 13M10.8 3 9.4 13" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="M3.6 6.4h9M3.4 9.6h9" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </>
  ),
  doc: (
    <>
      <path d="M4 2.5h5l3 3v8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Z" fill="currentColor" opacity="0.16" />
      <path d="M4 2.5h5l3 3v8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9 2.7V5.5h2.8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M5.7 8.6h4.6M5.7 10.5h4.6M5.7 12.1h3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
    </>
  ),
  image: (
    <>
      <rect x="2.5" y="3.6" width="11" height="8.8" rx="1.4" fill="currentColor" opacity="0.16" />
      <rect x="2.5" y="3.6" width="11" height="8.8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5.9" cy="6.6" r="1.1" fill="currentColor" />
      <path d="M3 11.4 6.6 7.9l2 2 1.9-1.7 2.5 2.3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.3" y="3.3" width="11.4" height="9.4" rx="1.5" fill="currentColor" opacity="0.16" />
      <rect x="2.3" y="3.3" width="11.4" height="9.4" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5 6.4 7.3 8 5 9.6" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.4 9.8h3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="8" cy="8" r="2" fill="currentColor" opacity="0.18" />
      <path d="M8 2.4v2.1M8 11.5v2.1M13.6 8h-2.1M4.5 8H2.4M11.96 4.04l-1.49 1.49M5.53 10.47l-1.49 1.49M11.96 11.96l-1.49-1.49M5.53 5.53 4.04 4.04" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </>
  ),
  markup: (
    <>
      <path d="M5.6 4.2 2.4 8l3.2 3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.4 4.2 13.6 8l-3.2 3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="4.6" rx="4.4" ry="1.8" fill="currentColor" opacity="0.18" />
      <path d="M3.6 4.6v6.8c0 1 2 1.8 4.4 1.8s4.4-.8 4.4-1.8V4.6" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <ellipse cx="8" cy="4.6" rx="4.4" ry="1.8" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3.6 8c0 1 2 1.8 4.4 1.8s4.4-.8 4.4-1.8" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.65" />
    </>
  ),
  archive: (
    <>
      <path d="M3 5.2 8 3.1l5 2.1v5.6L8 12.9 3 10.8V5.2Z" fill="currentColor" opacity="0.16" />
      <path d="M3 5.2 8 3.1l5 2.1v5.6L8 12.9 3 10.8V5.2Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M3 5.2 8 7.3l5-2.1M8 7.3v5.6" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M5.5 4.15 10.5 6.25" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.6" />
    </>
  ),
  chip: (
    <>
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.1" fill="currentColor" opacity="0.16" />
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.1" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" rx="0.5" fill="currentColor" opacity="0.5" />
      <path d="M6.5 2.6v1.6M9.5 2.6v1.6M6.5 11.8v1.6M9.5 11.8v1.6M2.6 6.5h1.6M2.6 9.5h1.6M11.8 6.5h1.6M11.8 9.5h1.6" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </>
  ),
  default: (
    <>
      <path d="M4 2.5h5l3 3v8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Z" fill="currentColor" opacity="0.14" />
      <path d="M4 2.5h5l3 3v8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9 2.7V5.5h2.8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </>
  ),
  folderClosed: (
    <>
      <path d="M2.4 5.4c0-.69.56-1.25 1.25-1.25h2.7c.33 0 .65.13.88.37l.72.72c.23.23.55.37.88.37h3.15c.69 0 1.25.56 1.25 1.25v4.05c0 .69-.56 1.25-1.25 1.25H3.65c-.69 0-1.25-.56-1.25-1.25V5.4Z" fill="currentColor" opacity="0.2" />
      <path d="M2.4 5.4c0-.69.56-1.25 1.25-1.25h2.7c.33 0 .65.13.88.37l.72.72c.23.23.55.37.88.37h3.15c.69 0 1.25.56 1.25 1.25v4.05c0 .69-.56 1.25-1.25 1.25H3.65c-.69 0-1.25-.56-1.25-1.25V5.4Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </>
  ),
  folderOpen: (
    <>
      <path d="M2.4 5.2c0-.69.56-1.25 1.25-1.25h2.7c.33 0 .65.13.88.37l.72.72c.23.23.55.37.88.37h3.15c.69 0 1.25.56 1.25 1.25v1.1H2.4V5.2Z" fill="currentColor" opacity="0.18" />
      <path d="M1.45 7.55h12.1l-1.16 3.88c-.17.56-.69.97-1.28.97H3.89c-.59 0-1.11-.41-1.28-.97L1.45 7.55Z" fill="currentColor" opacity="0.26" />
      <path d="M2.4 5.2c0-.69.56-1.25 1.25-1.25h2.7c.33 0 .65.13.88.37l.72.72c.23.23.55.37.88.37h3.15c.69 0 1.25.56 1.25 1.25v.8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M1.45 7.55h12.1l-1.16 3.88c-.17.56-.69.97-1.28.97H3.89c-.59 0-1.11-.41-1.28-.97L1.45 7.55Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </>
  ),
};

export function FileIcon({ name }: FileIconProps): ReactElement {
  const spec = resolveIconSpec(name);
  return (
    <svg
      className="fexp-file-svg"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ color: `var(--fexp-ic-${spec.tone})` }}
    >
      {SHAPES[spec.shape]}
    </svg>
  );
}

export function FolderIcon({ name, open }: FolderIconProps): ReactElement {
  const tone = SPECIAL_FOLDERS[name.toLowerCase()] ?? TONE.folder;
  return (
    <svg
      className="fexp-file-svg"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ color: `var(--fexp-ic-${tone})` }}
    >
      {open ? SHAPES.folderOpen : SHAPES.folderClosed}
    </svg>
  );
}

function resolveIconSpec(name: string): IconSpec {
  const lower = name.toLowerCase();

  const basename = BASENAME_SPECS[lower];
  if (basename) return basename;
  if (lower.startsWith(".env")) return { shape: "gear", tone: TONE.config };
  if (lower.startsWith("readme")) return { shape: "doc", tone: TONE.md };

  // 복합 확장자(.d.ts) 우선, 이후 마지막 확장자
  if (lower.endsWith(".d.ts")) return EXT_SPECS["d.ts"];
  const dot = lower.lastIndexOf(".");
  if (dot > 0 && dot < lower.length - 1) {
    const ext = lower.slice(dot + 1);
    const spec = EXT_SPECS[ext];
    if (spec) return spec;
  }
  return DEFAULT_SPEC;
}
