import { useMemo } from "react";

import { tokenize } from "../syntax/highlighter.js";

interface CodeViewerProps {
  readonly content: string;
  readonly lang: string;
  readonly truncated?: boolean;
}

export function CodeViewer({ content, lang, truncated }: CodeViewerProps) {
  const lines = useMemo(() => splitLines(content, lang), [content, lang]);

  return (
    <div className="fexp-code-wrap">
      {truncated && <div className="fexp-truncated-badge">File is too large — showing a partial preview</div>}
      <div className="fexp-code-scroll">
        <table className="fexp-code-table" aria-label="File contents">
          <tbody>
            {lines.map((line, idx) => (
              <tr key={idx} className="fexp-code-row">
                <td className="fexp-line-num" aria-hidden="true">{idx + 1}</td>
                <td
                  className="fexp-line-code"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: line }}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function splitLines(content: string, lang: string): readonly string[] {
  const rawLines = content.split("\n");
  return rawLines.map((line) => renderLine(line, lang));
}

function renderLine(line: string, lang: string): string {
  if (lang === "plaintext" || lang === "markdown") return escapeHtml(line) || " ";
  const tokens = tokenize(line, lang);
  return tokens.map((tok) => {
    const escaped = escapeHtml(tok.value);
    return tok.kind === "text" ? escaped : `<span class="syn-${tok.kind}">${escaped}</span>`;
  }).join("") || " ";
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
