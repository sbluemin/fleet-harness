import { React } from "@fleet-console/sdk/plugin/browser";
import { highlightCodeSnippet } from "@fleet-console/markdown/core";
import { diffSnippetLines, type SnippetDiffLine } from "@fleet-console/markdown/diff";
import { StreamedMarkdown } from "../streamed-markdown.js";
import type { AgentChatToolDetail } from "./chat-events.js";

type Section = AgentChatToolDetail["sections"][number];
type DiffRow = SnippetDiffLine;

function visibleError(value: string): string {
  return /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/u.exec(value)?.[1]?.trim() ?? value;
}

const labels = {
  ko: { command: "명령", output: "출력", read: "읽은 내용", write: "작성한 내용 · 이전 본문 없음", before: "이전 입력", after: "새 입력", message: "보낸 메시지", result: "도구 결과", diff: "변경 비교 · 실제 입력 old → new", pending: "결과를 기다리는 중", truncated: "일부만 표시 · 상한 초과", masked: "경로·자격증명 가림 적용", copy: "복사", copied: "복사됨", input: "도구 입력", reply: "도구 응답", local: "조각 내 행", file: "파일 행", failed: "실패한 호출 · 변경 적용 여부를 확인할 수 없음" },
  en: { command: "Command", output: "Output", read: "Read content", write: "Written content · no previous version", before: "Old input", after: "New input", message: "Sent message", result: "Tool result", diff: "Change comparison · actual input old → new", pending: "Waiting for result", truncated: "Excerpt only · limit reached", masked: "Paths and credentials masked", copy: "Copy", copied: "Copied", input: "Tool input", reply: "Tool result", local: "Snippet line", file: "File line", failed: "Failed call · changes are not confirmed" },
} as const;

function codeLanguage(name: string, kind: Section["kind"], text: string): string | null {
  if (kind === "command") return "bash";
  if (kind === "message") return "markdown";
  if (kind === "result" || kind === "output") {
    if (/^\s*[\[{]/.test(text)) {
      try { JSON.parse(text); return "json"; } catch { /* 일반 도구 출력 */ }
    }
    return null;
  }
  const ext = name.split(".").pop()?.toLowerCase();
  const langs: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", css: "css", html: "html", xml: "xml", py: "python", sh: "bash", md: "markdown" };
  return ext !== undefined ? langs[ext] ?? null : null;
}

function editRows(before: string, after: string): readonly DiffRow[] {
  if (before === "") return after === "" ? [] : after.split("\n").map((text, index) => ({ sign: "+" as const, text, after: index + 1 }));
  if (after === "") return before.split("\n").map((text, index) => ({ sign: "-" as const, text, before: index + 1 }));
  return diffSnippetLines(before, after);
}

function CodeRows({ rows, language, diff = false, numbered = true, localLabel, className = "" }: { readonly rows: readonly DiffRow[]; readonly language: string | null; readonly diff?: boolean; readonly numbered?: boolean; readonly localLabel: string; readonly className?: string }) {
  return <div className={`agent-chat-tool-code ${className}`} role="region" aria-label={localLabel} tabIndex={0}>
    <table><tbody>{rows.map((row, index) => <tr key={index} className={row.sign === "+" ? "is-added" : row.sign === "-" ? "is-removed" : ""}>
      {diff ? <td className="agent-chat-tool-number" aria-label={`${localLabel} ${row.before ?? "–"}`}>{row.before ?? ""}</td> : null}
      {numbered ? <td className="agent-chat-tool-number" aria-label={`${localLabel} ${row.after ?? row.before ?? "–"}`}>{row.after ?? (diff ? "" : row.before ?? "")}</td> : null}
      {diff ? <td className="agent-chat-tool-sign" aria-hidden="true">{row.sign}</td> : null}
      <td className="agent-chat-tool-code-text"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCodeSnippet(row.text, language) }} /></td>
    </tr>)}</tbody></table>
  </div>;
}

function AgentRows({ text, language }: { readonly text: string; readonly language: "en" | "ko" }) {
  const lines = text.split("\n");
  const rows = lines.flatMap((line) => {
    const own = /^This session is (\S+)/.exec(line);
    if (own) return [{ name: own[1]!, state: language === "ko" ? "이 세션" : "This session" }];
    const peer = /^\s{2,}(\S+)\s+·\s+\S+\s+·\s+(\S+)/.exec(line);
    const state = peer?.[2] ?? "";
    return peer ? [{ name: peer[1]!, state: language === "ko" ? ({ idle: "대기", busy: "작업 중" } as Record<string, string>)[state] ?? state : state }] : [];
  });
  if (rows.length === 0) return null;
  return <table className="agent-chat-tool-agents"><thead><tr><th>{language === "ko" ? "세션" : "Session"}</th><th>{language === "ko" ? "상태" : "State"}</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}><td>{row.name}</td><td>{row.state}</td></tr>)}</tbody></table>;
}

function CopyButton({ text, language }: { readonly text: string; readonly language: "en" | "ko" }) {
  const [copied, setCopied] = React.useState(false);
  return <button type="button" className="agent-chat-tool-copy" onClick={() => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  }}>{copied ? labels[language].copied : labels[language].copy}</button>;
}

export function ToolDetail({ detail, name, path, state, language }: { readonly detail: AgentChatToolDetail; readonly name: string; readonly path: string; readonly state: string | undefined; readonly language: "en" | "ko" }) {
  const t = labels[language];
  const sections = detail.sections;
  const rendered = new Set<number>();
  const isFailure = state === "fail";
  const shownSections = sections.filter((section) => !(state === "ok" && section.kind === "result" && ["Edit", "MultiEdit", "Write"].includes(name)
    && /^(?:The file .+ has been updated successfully\.|File (?:created|updated) successfully .+|Wrote the file\.)$/i.test(section.text.trim())));
  return <div className="agent-chat-tool-detail">
    {isFailure && sections.some((section) => section.kind === "write" || section.kind === "before") ? <p className="agent-chat-tool-warning">{t.failed}</p> : null}
    {shownSections.map((section, index) => {
      if (rendered.has(index)) return null;
      const next = shownSections[index + 1];
      const isPair = section.kind === "before" && next?.kind === "after" && section.pair === next.pair;
      if (isPair) rendered.add(index + 1);
      const actual = isPair && next ? [section, next] : [section];
      const title = isPair ? `${t.diff}${section.pair !== undefined && section.pair > 0 ? ` ${section.pair + 1}` : ""}`
        : section.kind === "write" && state !== "ok" ? language === "ko" ? "작성 요청 내용 · 이전 본문 없음" : "Requested content · no previous version"
        : section.kind === "result" && name === "ListAgents" ? language === "ko" ? "세션 목록" : "Sessions"
        : section.kind === "result" && name === "SendMessage" ? language === "ko" ? "전달 결과" : "Delivery result"
        : t[section.kind];
      const origin = section.kind === "read" || section.kind === "output" || section.kind === "result" ? t.reply : t.input;
      const content = isPair && next ? `${section.text}\n→\n${next.text}` : section.text;
      const shown = section.kind === "write" && content.endsWith("\n") ? content.slice(0, -1)
        : isFailure && (section.kind === "result" || section.kind === "output") ? visibleError(content) : content;
      const recipientLine = section.kind === "message" && section.text.startsWith("→ ") ? section.text.indexOf("\n") : -1;
      const lang = codeLanguage(path, section.kind, content);
      return <section className="agent-chat-tool-section" key={index}>
        <div className="agent-chat-tool-heading"><strong>{title}</strong><span className="agent-chat-tool-origin">{origin}</span><span className="agent-chat-tool-spacer"/><CopyButton text={content} language={language}/></div>
        {section.kind === "message" ? <>
          {recipientLine > 0 ? <div className="agent-chat-tool-recipient">{section.text.slice(0, recipientLine)}</div> : null}
          <StreamedMarkdown text={recipientLine > 0 ? section.text.slice(recipientLine + 1) : section.text} streaming={false} className="agent-chat-tool-message markdown-body" language={language} />
        </>
          : isPair && next ? <CodeRows rows={editRows(section.text, next.text)} language={lang} diff localLabel={t.local}/>
            : name === "ListAgents" && section.kind === "result" && /This session is|Peer sessions/.test(section.text)
              ? <><AgentRows text={section.text} language={language}/><details className="agent-chat-tool-raw"><summary>{language === "ko" ? "결과 원문" : "Original result"}</summary>
                  <CodeRows rows={section.text.split("\n").map((text, at) => ({ sign: " " as const, before: at + 1, text }))} language={null} numbered={false} localLabel={t.local}/>
                </details></>
              : <CodeRows rows={shown.split("\n").map((text, at) => ({ sign: " " as const, before: section.firstLine !== undefined ? section.firstLine + at : at + 1, text }))} language={lang} numbered={section.kind !== "output" && (section.kind !== "read" || section.firstLine !== undefined)} className={section.kind === "command" ? "is-command" : section.kind === "output" || (section.kind === "read" && section.firstLine === undefined) ? "is-output" : ""} localLabel={section.kind === "read" && section.firstLine !== undefined ? t.file : t.local}/>}
        {actual.some((entry) => entry.truncated) ? <div className="agent-chat-tool-truncated">{t.truncated}{section.totalLines !== undefined ? ` · ${section.totalLines}${language === "ko" ? "줄 중" : " lines"}` : ""}</div> : null}
      </section>;
    })}
    {state === "running" && !sections.some((section) => section.kind === "output" || section.kind === "result" || section.kind === "read") ? <div className="agent-chat-tool-pending">{t.pending}</div> : null}
    {shownSections.some((section) => section.masked) ? <span className="agent-chat-tool-mask-note">{t.masked}</span> : null}
  </div>;
}
