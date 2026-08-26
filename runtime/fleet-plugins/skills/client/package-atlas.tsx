import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";

import type {
  SkillListItem,
  SkillPackageFile,
  SkillPackageFileResult,
  SkillPackageResult,
} from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import { MarkdownView } from "./markdown-view.js";

interface PackageAtlasProps {
  readonly skill: SkillListItem;
  readonly theaterId: string | null;
  readonly t: Translate<SkillsMessageKey>;
  readonly language: ConsoleLocale | undefined;
}

const ROLE_ORDER: readonly SkillPackageFile["role"][] = ["entry", "reference", "script", "asset", "file"];

function packageRequestBody(skill: SkillListItem, theaterId: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { scope: skill.scope, skill: skill.name };
  if (skill.scope === "project" && theaterId) body["theaterId"] = theaterId;
  return body;
}

function roleLabel(role: SkillPackageFile["role"], t: Translate<SkillsMessageKey>): string {
  return t(`skills.package.role.${role}`);
}

function fileIcon(file: SkillPackageFile): string {
  if (file.role === "entry") return "◆";
  if (file.role === "script") return ">_";
  if (file.role === "asset") return "◇";
  return "·";
}

export function PackageAtlas({ skill, theaterId, t, language }: PackageAtlasProps) {
  const [packageResult, setPackageResult] = useState<SkillPackageResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadedFile, setLoadedFile] = useState<SkillPackageFileResult | null>(null);
  const [loadingPackage, setLoadingPackage] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [packageFailed, setPackageFailed] = useState(false);
  const [fileFailed, setFileFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const fileAbortRef = useRef<AbortController | null>(null);
  const packageAbortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const loadFile = useCallback(async (filePath: string) => {
    fileAbortRef.current?.abort();
    const abort = new AbortController();
    fileAbortRef.current = abort;
    setSelectedPath(filePath);
    setLoadingFile(true);
    setFileFailed(false);
    setLoadedFile(null);
    try {
      const response = await fetch("/plugins/skills/installed-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...packageRequestBody(skill, theaterId), file: filePath }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json() as SkillPackageFileResult;
      if (!abort.signal.aborted) setLoadedFile(result);
    } catch {
      if (!abort.signal.aborted) setFileFailed(true);
    } finally {
      if (!abort.signal.aborted) setLoadingFile(false);
    }
  }, [skill, theaterId]);

  const loadPackage = useCallback(async () => {
    packageAbortRef.current?.abort();
    fileAbortRef.current?.abort();
    const abort = new AbortController();
    packageAbortRef.current = abort;
    fileButtonsRef.current.clear();
    setLoadingPackage(true);
    setPackageFailed(false);
    setPackageResult(null);
    setSelectedPath(null);
    setLoadedFile(null);
    try {
      const response = await fetch("/plugins/skills/installed-package", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packageRequestBody(skill, theaterId)),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json() as SkillPackageResult;
      if (!abort.signal.aborted) setPackageResult(result);
    } catch {
      if (!abort.signal.aborted) setPackageFailed(true);
    } finally {
      if (!abort.signal.aborted) setLoadingPackage(false);
    }
  }, [skill, theaterId]);

  useEffect(() => {
    void loadPackage();
    return () => {
      packageAbortRef.current?.abort();
      fileAbortRef.current?.abort();
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      fileButtonsRef.current.clear();
    };
  }, [loadPackage]);

  const groupedFiles = useMemo(() => {
    const groups = new Map<SkillPackageFile["role"], SkillPackageFile[]>();
    for (const role of ROLE_ORDER) groups.set(role, []);
    for (const file of packageResult?.manifest.files ?? []) groups.get(file.role)?.push(file);
    return ROLE_ORDER.map((role) => ({ role, files: groups.get(role) ?? [] })).filter((group) => group.files.length > 0);
  }, [packageResult]);

  const readableFiles = useMemo(
    () => packageResult?.manifest.files.filter((candidate) => candidate.readable) ?? [],
    [packageResult],
  );

  const handleFileKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, file: SkillPackageFile) => {
    const index = readableFiles.findIndex((candidate) => candidate.path === file.path);
    if (index === -1) return;
    let nextIndex = index;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % readableFiles.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + readableFiles.length) % readableFiles.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = readableFiles.length - 1;
    else return;
    event.preventDefault();
    const next = readableFiles[nextIndex];
    if (next) fileButtonsRef.current.get(next.path)?.focus();
  }, [readableFiles]);

  const copyPath = useCallback(() => {
    const displayPath = packageResult?.displayPath;
    if (!displayPath || !navigator.clipboard) return;
    void navigator.clipboard.writeText(displayPath).then(() => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1200);
    }).catch(() => {});
  }, [packageResult]);

  if (loadingPackage) return <div className="skills-empty-state" role="status">{t("skills.package.loading")}</div>;
  if (packageFailed) {
    return (
      <FailureNotice
        title={t("skills.failure.package.title")}
        cause={t("skills.failure.package.cause")}
        actions={[{ label: t("skills.action.retry"), onSelect: () => { void loadPackage(); }, primary: true }]}
        tone="coral"
        className="skills-package-failure"
      />
    );
  }
  if (!packageResult) return null;

  if (selectedPath) {
    return (
      <div className="skills-package-reader">
        <nav className="skills-package-breadcrumb" aria-label={t("skills.package.breadcrumbAria")}>
          <button type="button" onClick={() => { setSelectedPath(null); setLoadedFile(null); setFileFailed(false); }}>
            {skill.name}
          </button>
          <span aria-hidden="true">/</span>
          <span>{selectedPath}</span>
        </nav>
        <div className="skills-package-reader-body">
          {loadingFile ? <div className="skills-empty-state" role="status">{t("skills.package.fileLoading")}</div> : null}
          {fileFailed ? (
            <FailureNotice
              title={t("skills.failure.file.title")}
              cause={t("skills.failure.file.cause")}
              actions={[{ label: t("skills.action.retry"), onSelect: () => { void loadFile(selectedPath); }, primary: true }]}
              tone="coral"
            />
          ) : null}
          {loadedFile?.file.format === "markdown" ? (
            <MarkdownView
              content={loadedFile.content}
              language={language}
              currentPath={loadedFile.file.path}
              onOpenRelativeFile={loadFile}
            />
          ) : null}
          {loadedFile && loadedFile.file.format !== "markdown" ? (
            <pre className="skills-package-code"><code>{loadedFile.content}</code></pre>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="skills-package-atlas">
      <section className="skills-package-overview" aria-labelledby="skills-package-title">
        <div className="skills-package-intro">
          <div>
            <h2 id="skills-package-title">{skill.name}</h2>
            {skill.description ? <p>{skill.description}</p> : null}
          </div>
          <span>{t("skills.package.summary", {
            files: packageResult.manifest.files.length,
            folders: packageResult.manifest.folderCount,
          })}</span>
        </div>
        <div className="skills-package-groups">
          {groupedFiles.map((group) => (
            <section key={group.role} className={`skills-package-group is-${group.role}`}>
              <header><h3>{roleLabel(group.role, t)}</h3><span>{group.files.length}</span></header>
              <div className="skills-package-file-list">
                {group.files.map((file) => (
                  <button
                    key={file.path}
                    ref={(node) => { if (node) fileButtonsRef.current.set(file.path, node); else fileButtonsRef.current.delete(file.path); }}
                    type="button"
                    className="skills-package-file"
                    disabled={!file.readable}
                    onClick={() => { void loadFile(file.path); }}
                    onKeyDown={(event) => handleFileKeyDown(event, file)}
                    title={!file.readable ? t("skills.package.unsupported") : undefined}
                  >
                    <span className="skills-package-file-icon" aria-hidden="true">{fileIcon(file)}</span>
                    <span className="skills-package-file-copy"><strong>{file.name}</strong><span>{file.path}</span></span>
                    <span className="skills-package-file-size">{formatBytes(file.size)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
      <aside className="skills-package-inspector">
        <h3>{t("skills.package.contract")}</h3>
        <dl>
          <dt>{t("skills.package.entry")}</dt><dd>SKILL.md</dd>
          <dt>{t("skills.package.files")}</dt><dd>{packageResult.manifest.files.length}</dd>
          <dt>{t("skills.package.folders")}</dt><dd>{packageResult.manifest.folderCount}</dd>
          <dt>{t("skills.package.size")}</dt><dd>{formatBytes(packageResult.manifest.totalBytes)}</dd>
        </dl>
        <button type="button" className="skills-btn skills-btn--ghost skills-package-copy" onClick={copyPath}>
          {copied ? t("skills.markdown.copied") : t("skills.package.copyPath")}
        </button>
        <p className="skills-package-path">{packageResult.displayPath}</p>
        {packageResult.manifest.truncated || packageResult.manifest.tooLarge || packageResult.manifest.omittedSymlinks > 0 ? (
          <p className="skills-package-limit-note">
            {t("skills.package.limited", { count: packageResult.manifest.omittedSymlinks })}
          </p>
        ) : null}
        <p className="skills-package-safety">{t("skills.package.safety")}</p>
      </aside>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
