export interface Token {
  readonly kind: "key" | "str" | "num" | "com" | "fn" | "tag" | "attr" | "punct" | "text";
  readonly value: string;
}

export function tokenize(code: string, lang: string): readonly Token[] {
  switch (lang) {
    case "typescript":
    case "javascript":
      return tokenizeJs(code);
    case "json":
      return tokenizeJson(code);
    case "python":
      return tokenizePython(code);
    case "css":
    case "scss":
    case "sass":
    case "less":
      return tokenizeCss(code);
    case "html":
    case "xml":
      return tokenizeHtml(code);
    case "bash":
    case "shell":
      return tokenizeShell(code);
    case "yaml":
      return tokenizeYaml(code);
    default:
      return [{ kind: "text", value: code }];
  }
}

const JS_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "from", "function", "if",
  "implements", "import", "in", "instanceof", "interface", "is", "keyof",
  "let", "namespace", "new", "null", "of", "override", "package", "private",
  "protected", "public", "readonly", "return", "satisfies", "static", "super",
  "switch", "this", "throw", "true", "try", "type", "typeof", "undefined",
  "var", "void", "while", "with", "yield",
]);

function tokenizeJs(code: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    // 블록 주석
    if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      tokens.push({ kind: "com", value: slice });
      i += slice.length;
      continue;
    }
    // 라인 주석
    if (code.startsWith("//", i)) {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ kind: "com", value: slice });
      i += slice.length;
      continue;
    }
    // 탬플릿 리터럴
    if (code[i] === "`") {
      const { slice, length } = readString(code, i, "`", "`");
      tokens.push({ kind: "str", value: slice });
      i += length;
      continue;
    }
    // 문자열 " 또는 '
    if (code[i] === '"' || code[i] === "'") {
      const { slice, length } = readString(code, i, code[i]!, code[i]!);
      tokens.push({ kind: "str", value: slice });
      i += length;
      continue;
    }
    // 숫자 리터럴
    if (/[0-9]/.test(code[i]!) || (code[i] === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      const match = code.slice(i).match(/^(0x[\da-fA-F]+|0o[0-7]+|0b[01]+|[\d]*\.?[\d]+(?:[eE][+-]?\d+)?[nN]?)/);
      if (match) {
        tokens.push({ kind: "num", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    // 식별자 / 키워드 / 함수명
    if (/[a-zA-Z_$]/.test(code[i]!)) {
      const match = code.slice(i).match(/^[a-zA-Z_$][\w$]*/);
      if (match) {
        const word = match[0];
        const afterWord = code.slice(i + word.length).match(/^\s*\(/);
        if (JS_KEYWORDS.has(word)) {
          tokens.push({ kind: "key", value: word });
        } else if (afterWord) {
          tokens.push({ kind: "fn", value: word });
        } else {
          tokens.push({ kind: "text", value: word });
        }
        i += word.length;
        continue;
      }
    }
    // 문장 부호
    if (/[{}()[\];,.<>!?:|&^~%*+\-=/\\@#]/.test(code[i]!)) {
      tokens.push({ kind: "punct", value: code[i]! });
      i++;
      continue;
    }
    tokens.push({ kind: "text", value: code[i]! });
    i++;
  }
  return tokens;
}

function tokenizeJson(code: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code[i] === '"') {
      const { slice, length } = readString(code, i, '"', '"');
      // 콜론 뒤에 오는 문자열은 값이고, 그 전은 키
      const afterStr = code.slice(i + length).trimStart();
      const isKey = afterStr.startsWith(":");
      tokens.push({ kind: isKey ? "attr" : "str", value: slice });
      i += length;
      continue;
    }
    if (/[0-9\-]/.test(code[i]!)) {
      const match = code.slice(i).match(/^-?[\d]*\.?[\d]+(?:[eE][+-]?\d+)?/);
      if (match) {
        tokens.push({ kind: "num", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    if (code.startsWith("true", i) || code.startsWith("false", i) || code.startsWith("null", i)) {
      const match = code.slice(i).match(/^(true|false|null)/);
      if (match) {
        tokens.push({ kind: "key", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    if (/[{}[\]:,]/.test(code[i]!)) {
      tokens.push({ kind: "punct", value: code[i]! });
      i++;
      continue;
    }
    tokens.push({ kind: "text", value: code[i]! });
    i++;
  }
  return tokens;
}

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield",
]);

function tokenizePython(code: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code[i] === "#") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ kind: "com", value: slice });
      i += slice.length;
      continue;
    }
    if (code.startsWith('"""', i) || code.startsWith("'''", i)) {
      const q = code.slice(i, i + 3);
      const end = code.indexOf(q, i + 3);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end + 3);
      tokens.push({ kind: "str", value: slice });
      i += slice.length;
      continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const { slice, length } = readString(code, i, code[i]!, code[i]!);
      tokens.push({ kind: "str", value: slice });
      i += length;
      continue;
    }
    if (/[0-9]/.test(code[i]!)) {
      const match = code.slice(i).match(/^(0x[\da-fA-F]+|0o[0-7]+|0b[01]+|[\d]*\.?[\d]+(?:[eE][+-]?\d+)?)/);
      if (match) {
        tokens.push({ kind: "num", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    if (/[a-zA-Z_]/.test(code[i]!)) {
      const match = code.slice(i).match(/^[a-zA-Z_]\w*/);
      if (match) {
        const word = match[0];
        const afterWord = code.slice(i + word.length).match(/^\s*\(/);
        if (PY_KEYWORDS.has(word)) {
          tokens.push({ kind: "key", value: word });
        } else if (afterWord) {
          tokens.push({ kind: "fn", value: word });
        } else {
          tokens.push({ kind: "text", value: word });
        }
        i += word.length;
        continue;
      }
    }
    tokens.push({ kind: "text", value: code[i]! });
    i++;
  }
  return tokens;
}

function tokenizeCss(code: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      tokens.push({ kind: "com", value: slice });
      i += slice.length;
      continue;
    }
    if (code.startsWith("//", i)) {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ kind: "com", value: slice });
      i += slice.length;
      continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const { slice, length } = readString(code, i, code[i]!, code[i]!);
      tokens.push({ kind: "str", value: slice });
      i += length;
      continue;
    }
    // 선택자 (.class, #id, :pseudo, ::before)
    if (code[i] === "." || code[i] === "#" || code[i] === ":") {
      const match = code.slice(i).match(/^[.#:][:a-zA-Z_-][\w-]*/);
      if (match) {
        tokens.push({ kind: "tag", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    // 속성명 (word before :)
    if (/[a-zA-Z-]/.test(code[i]!)) {
      const match = code.slice(i).match(/^[a-zA-Z-][\w-]*/);
      if (match) {
        const word = match[0];
        const after = code.slice(i + word.length).trimStart();
        if (after.startsWith(":")) {
          tokens.push({ kind: "attr", value: word });
        } else {
          tokens.push({ kind: "text", value: word });
        }
        i += word.length;
        continue;
      }
    }
    if (/[0-9]/.test(code[i]!)) {
      const match = code.slice(i).match(/^[\d]*\.?[\d]+(?:[a-zA-Z%]*)/);
      if (match) {
        tokens.push({ kind: "num", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    tokens.push({ kind: "text", value: code[i]! });
    i++;
  }
  return tokens;
}

function tokenizeHtml(code: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i + 4);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end + 3);
      tokens.push({ kind: "com", value: slice });
      i += slice.length;
      continue;
    }
    if (code[i] === "<") {
      tokens.push({ kind: "punct", value: "<" });
      i++;
      if (code[i] === "/") {
        tokens.push({ kind: "punct", value: "/" });
        i++;
      }
      const tagMatch = code.slice(i).match(/^[a-zA-Z][\w:-]*/);
      if (tagMatch) {
        tokens.push({ kind: "tag", value: tagMatch[0] });
        i += tagMatch[0].length;
      }
      continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const { slice, length } = readString(code, i, code[i]!, code[i]!);
      tokens.push({ kind: "str", value: slice });
      i += length;
      continue;
    }
    if (/[a-zA-Z]/.test(code[i]!)) {
      const match = code.slice(i).match(/^[a-zA-Z][\w:-]*/);
      if (match) {
        const after = code.slice(i + match[0].length).trimStart();
        tokens.push({ kind: after.startsWith("=") ? "attr" : "text", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    tokens.push({ kind: "text", value: code[i]! });
    i++;
  }
  return tokens;
}

function tokenizeShell(code: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const SH_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "return", "local", "export", "readonly", "declare", "unset", "echo", "exit", "shift", "source", "."]);
  while (i < code.length) {
    if (code[i] === "#") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ kind: "com", value: slice });
      i += slice.length;
      continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const { slice, length } = readString(code, i, code[i]!, code[i]!);
      tokens.push({ kind: "str", value: slice });
      i += length;
      continue;
    }
    if (/[a-zA-Z_]/.test(code[i]!)) {
      const match = code.slice(i).match(/^[a-zA-Z_][\w]*/);
      if (match) {
        tokens.push({ kind: SH_KEYWORDS.has(match[0]) ? "key" : "text", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    tokens.push({ kind: "text", value: code[i]! });
    i++;
  }
  return tokens;
}

function tokenizeYaml(code: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code[i] === "#") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ kind: "com", value: slice });
      i += slice.length;
      continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const { slice, length } = readString(code, i, code[i]!, code[i]!);
      tokens.push({ kind: "str", value: slice });
      i += length;
      continue;
    }
    // YAML 키: "word:" 패턴
    if (/[a-zA-Z_]/.test(code[i]!)) {
      const match = code.slice(i).match(/^[a-zA-Z_][\w-]*/);
      if (match) {
        const after = code.slice(i + match[0].length).trimStart();
        if (after.startsWith(":")) {
          tokens.push({ kind: "attr", value: match[0] });
        } else if (["true", "false", "null", "yes", "no", "on", "off"].includes(match[0])) {
          tokens.push({ kind: "key", value: match[0] });
        } else {
          tokens.push({ kind: "text", value: match[0] });
        }
        i += match[0].length;
        continue;
      }
    }
    if (/[0-9\-]/.test(code[i]!)) {
      const match = code.slice(i).match(/^-?[\d]*\.?[\d]+/);
      if (match) {
        tokens.push({ kind: "num", value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    tokens.push({ kind: "text", value: code[i]! });
    i++;
  }
  return tokens;
}

function readString(code: string, start: number, open: string, close: string): { slice: string; length: number } {
  let i = start + open.length;
  while (i < code.length) {
    if (code[i] === "\\") { i += 2; continue; }
    if (code.startsWith(close, i)) { i += close.length; break; }
    if (close !== "`" && code[i] === "\n") break;
    i++;
  }
  return { slice: code.slice(start, i), length: i - start };
}
