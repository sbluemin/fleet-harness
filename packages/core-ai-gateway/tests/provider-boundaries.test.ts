import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

import { describe, expect, it } from "vitest";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const PROVIDER_FOLDERS = ["codex", "cursor", "kimi", "opencode-go"] as const;

const SELF_PACKAGE = "@dotobokuri/core-ai-gateway";

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Static module specifiers in a module's source, in declaration order, via a real
 * TypeScript AST parse. Static `import … from`/`export … from` (including multiline
 * specifiers and side-effect `import "…"`), dynamic `import("…")`, type-level
 * `import("…").T`, and CJS `require("…")`/`createRequire(...)("…")` are collected
 * only when the specifier is a static literal (`"…"`/`'…'` or a no-substitution
 * `` `…` ``) — comments and string literals are never module-specifier positions.
 * Computed dependencies whose target cannot be statically resolved are not collected
 * here; they are reported by {@link nonStaticDependencies} and rejected.
 */
function moduleSpecifiers(text: string): string[] {
  const sourceFile = ts.createSourceFile(
    "probe.ts",
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isStaticSpecifier(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier !== undefined
      && isStaticSpecifier(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
      && isStaticSpecifier(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)
    ) {
      // Type-level `import("…").T` is a real cross-module dependency too.
      // A template-literal ImportTypeNode is a TS1141 error, so string literals suffice.
      specifiers.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
      && node.arguments.length > 0
      && isStaticSpecifier(node.arguments[0])
    ) {
      // CJS require bypasses the ESM import grammar; Node types still allow it.
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isCallExpression(node)
      && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "createRequire"
      && node.arguments.length > 0
      && isStaticSpecifier(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/**
 * A statically resolvable module-specifier literal: `"…"`/`'…'` and the
 * no-substitution `` `…` `` template (valid ESNext for dynamic import/require).
 * An interpolated template (`` `../${name}.js` ``) is computed at runtime and
 * has no static provider target, so it is deliberately not a static specifier.
 */
function isStaticSpecifier(node: ts.Node): node is ts.StringLiteralLike {
  return ts.isStringLiteralLike(node);
}

/** A computed module dependency whose target cannot be statically resolved. */
interface ComputedDependency {
  readonly kind: "import" | "require" | "createRequire";
  /** Short `syntax(<argument-kind>)` description for assertion messages. */
  readonly syntax: string;
}

/**
 * Computed (non-static) module dependencies in a module's source: `import(expr)`,
 * `require(expr)`, and `createRequire(...)(expr)` whose first argument is not a
 * static literal (a string or no-substitution template). Their target is decided at
 * runtime, so a provider boundary could point anywhere and stay invisible to static
 * checks — the boundary test rejects every one of them.
 */
function nonStaticDependencies(text: string): ComputedDependency[] {
  const sourceFile = ts.createSourceFile(
    "probe.ts",
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const found: ComputedDependency[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0 && !isStaticSpecifier(node.arguments[0])) {
      let kind: ComputedDependency["kind"] | undefined;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        kind = "import";
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        kind = "require";
      } else if (
        ts.isCallExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "createRequire"
      ) {
        kind = "createRequire";
      }
      if (kind !== undefined) {
        const argumentKind = ts.SyntaxKind[node.arguments[0].kind].toLowerCase();
        found.push({ kind, syntax: `${kind}(${argumentKind})` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function specifiersOf(file: string): string[] {
  return moduleSpecifiers(readFileSync(file, "utf8"));
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isSelfPackage(specifier: string): boolean {
  return specifier === SELF_PACKAGE || specifier.startsWith(`${SELF_PACKAGE}/`);
}

function isWithin(parent: string, file: string): boolean {
  const rel = path.relative(parent, file);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * First path segment of a repo-relative path. `path.relative` uses `\` on Windows
 * and `/` elsewhere, so a hardcoded `/` would silently skip every classification
 * on Windows; splitting on both separators keeps owner/shared/seam checks OS-neutral.
 */
function firstPathSegment(rel: string): string {
  return rel.split(/[\\/]/)[0];
}

/** The two Anthropic modules providers may import: client-facing protocol normalization. */
const SHARED_ANTHROPIC_MODULES = new Set([
  "anthropic/protocol.js",
  "anthropic/passthrough.js",
  "anthropic/protocol.ts",
  "anthropic/passthrough.ts",
]);

/**
 * True when a `src`-relative path targets one of the shared Anthropic normalization
 * modules. `native.ts` is Anthropic-owned provider semantics, and `gateway.ts`/
 * `claude-context.ts` are the client-facing compatibility seam — neither is a shared
 * allowlist entry, and `index.ts` is the seam's own barrel.
 */
function isSharedAnthropicModule(srcRelative: string): boolean {
  return SHARED_ANTHROPIC_MODULES.has(srcRelative.split(/[\\/]/).join("/"));
}

function providerOf(file: string): string | undefined {
  const first = firstPathSegment(path.relative(srcDir, file));
  return (PROVIDER_FOLDERS as readonly string[]).includes(first) ? first : undefined;
}

describe("core-ai-gateway provider boundaries", () => {
  it("rejects self-package imports and subpaths from internal source files", () => {
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      const offenders = specifiersOf(file).filter(isSelfPackage);
      expect(offenders, `${rel} imports its own package`).toEqual([]);
    }
  });

  it("rejects computed (non-static) module dependencies from internal source files", () => {
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      const deps = nonStaticDependencies(readFileSync(file, "utf8"));
      expect(
        deps.map((dependency) => dependency.syntax),
        `${rel} uses a computed module dependency whose target cannot be boundary-checked`,
      ).toEqual([]);
    }
  });

  it("keeps canonical and transport free of provider imports", () => {
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      const first = firstPathSegment(rel);
      const isShared = first === "canonical" || first === "transport";
      if (!isShared) continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        const target = isWithin(srcDir, resolved) ? providerOf(resolved) : undefined;
        expect(target, `${rel} imports provider folder ${target}`).toBeUndefined();
      }
    }
  });

  it("keeps each provider folder from importing another provider folder", () => {
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      const owner = PROVIDER_FOLDERS.find((provider) => firstPathSegment(rel) === provider);
      if (owner === undefined) continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        const target = isWithin(srcDir, resolved) ? providerOf(resolved) : undefined;
        if (target === undefined) continue;
        expect(target, `${rel} imports provider folder ${target}`).toBe(owner);
      }
    }
  });

  it("keeps the anthropic seam from importing provider folders except the gateway default", () => {
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      if (firstPathSegment(rel) !== "anthropic") continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        const target = isWithin(srcDir, resolved) ? providerOf(resolved) : undefined;
        if (target === undefined) continue;
        // Sanctioned compatibility exception: AnthropicMessagesGateway's backwards-
        // compatible default constructor imports OpenAIResponsesAdapter from
        // codex/responses/adapter.js. Anything else from the seam into a provider is a violation.
        const relParts = rel.split(/[\\/]/);
        const isGatewayFile = relParts.length === 2
          && relParts[0] === "anthropic"
          && relParts[1] === "gateway.ts";
        const isGatewayDefault = isGatewayFile
          && resolved === path.join(srcDir, "codex", "responses", "adapter.js");
        expect(isGatewayDefault, `${rel} imports provider folder ${target}`).toBe(true);
      }
    }
  });

  it("allows provider folders to import only the shared Anthropic normalization modules", () => {
    // Cross-provider shared Anthropic allowlist is exactly protocol.ts + passthrough.ts.
    // native.ts is Anthropic-owned provider semantics and gateway/claude-context are the
    // compatibility seam — neither is shared, and the seam barrel index.js is internal.
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      const owner = PROVIDER_FOLDERS.find((provider) => firstPathSegment(rel) === provider);
      if (owner === undefined) continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!isWithin(srcDir, resolved)) continue;
        if (firstPathSegment(path.relative(srcDir, resolved)) !== "anthropic") continue;
        expect(
          isSharedAnthropicModule(path.relative(srcDir, resolved)),
          `${rel} imports ${specifier} — only anthropic/protocol.js and anthropic/passthrough.js are shared`,
        ).toBe(true);
      }
    }
  });

  it("keeps package-internal files from importing the root facade", () => {
    // A relative facade specifier resolves to `index.js`; the on-disk file is `index.ts`.
    const facadePaths = new Set([
      path.join(srcDir, "index.js"),
      path.join(srcDir, "index.ts"),
    ]);
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      if (rel === "index.ts") continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        expect(
          facadePaths.has(resolved),
          `${rel} imports the root facade ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("owns all three OpenCode wire implementations under src/opencode-go", () => {
    for (const rel of [
      "opencode-go/anthropic/index.ts",
      "opencode-go/responses/adapter.ts",
      "opencode-go/chat-completions/adapter.ts",
    ]) {
      expect(existsSync(path.join(srcDir, rel)), rel).toBe(true);
    }
  });

  it("removed the old root adapter and seam files", () => {
    for (const name of [
      "openai-chat-adapter.ts",
      "openai-responses-adapter.ts",
      "cursor-adapter.ts",
      "provider-credentials.ts",
      "opencode-go.ts",
      "canonical.ts",
      "anthropic.ts",
      "gateway.ts",
      "claude-context.ts",
      "upstream-sse.ts",
      "token-estimate.ts",
      "wire-log.ts",
      "sse-keepalive.ts",
    ]) {
      expect(existsSync(path.join(srcDir, name)), name).toBe(false);
    }
  });

  it("keeps cursor exec-responses and exec-redirect internal to the cursor folder", () => {
    // The only path from the root facade to those modules is the cursor/native barrel,
    // so pinning the barrel means CursorClientToolReference, CursorUnknownExecReply,
    // cursorNativeExecPolicyReplies, cursorNativeExecRedirect, cursorUnknownExecCaseName,
    // and cursorUnknownExecReply stay out of the package-level public surface.
    const nativeIndexSpecifiers = moduleSpecifiers(
      readFileSync(path.join(srcDir, "cursor", "native", "index.ts"), "utf8"),
    );
    expect(nativeIndexSpecifiers).not.toContain("./exec-responses.js");
    expect(nativeIndexSpecifiers).not.toContain("./exec-redirect.js");
  });
});

// Extractor assertions: pin the AST extraction shapes the boundary checks rely on.
describe("gateway module specifier extraction", () => {
  it("captures static multiline, export-from, dynamic, and side-effect imports", () => {
    expect(moduleSpecifiers(`
      import { A } from "./a.js";
      import {
        B,
      } from "./b.js";
      import type { C } from "./c.js";
      export * from "./d.js";
      export { E } from
        "./e.js";
      import "./side.js";
      import './side-single.js';
      const d = import("./f.js");
      const e = import('./g.js');
    `)).toEqual([
      "./a.js",
      "./b.js",
      "./c.js",
      "./d.js",
      "./e.js",
      "./side.js",
      "./side-single.js",
      "./f.js",
      "./g.js",
    ]);
  });

  it("ignores specifier-looking text in comments and strings", () => {
    expect(moduleSpecifiers(`
      // import { X } from "./fake.js";
      /* export { Y } from "./also-fake.js"; */
      const s = "from \\"./string-fake.js\\"";
      import { Real } from "./real.js";
    `)).toEqual(["./real.js"]);
  });

  it("exposes relative facade and self-package specifiers for the boundary checks", () => {
    expect(moduleSpecifiers(`
      import { Facade } from "../../index.js";
      import { A } from "@dotobokuri/core-ai-gateway";
      import { B } from "@dotobokuri/core-ai-gateway/models";
      import { C } from "node:fs";
      import { D } from "@bufbuild/protobuf";
    `)).toEqual([
      "../../index.js",
      "@dotobokuri/core-ai-gateway",
      "@dotobokuri/core-ai-gateway/models",
      "node:fs",
      "@bufbuild/protobuf",
    ]);
  });

  it("captures type-level imports, require, and createRequire specifiers", () => {
    expect(moduleSpecifiers(`
      type T = import("../../codex/x.js").T;
      const r = require("../cursor/y.js");
      const cr = createRequire(import.meta.url)("../../kimi/z.js");
      import { E } from "./e.js";
    `)).toEqual([
      "../../codex/x.js",
      "../cursor/y.js",
      "../../kimi/z.js",
      "./e.js",
    ]);
  });

  it("captures no-substitution template specifiers but never interpolated ones", () => {
    expect(moduleSpecifiers(`
      const a = import(\`../../codex/x.js\`);
      const r = require(\`../cursor/y.js\`);
      const cr = createRequire(import.meta.url)(\`../../kimi/z.js\`);
      const dyn = import(\`../\${name}.js\`);
    `)).toEqual([
      "../../codex/x.js",
      "../cursor/y.js",
      "../../kimi/z.js",
    ]);
  });

  it("classifies owner and seam segments OS-neutrally across win32 separators", () => {
    // `path.relative` uses `\` on Windows; the boundary checks must not silently
    // skip when that happens, so the first-segment classification is pinned for both.
    expect(firstPathSegment(path.win32.relative("C:\\src", "C:\\src\\codex\\responses\\adapter.ts"))).toBe("codex");
    expect(firstPathSegment(path.win32.relative("C:\\src", "C:\\src\\anthropic\\gateway.ts"))).toBe("anthropic");
    expect(firstPathSegment(path.win32.relative("C:\\src", "C:\\src\\transport\\credentials.ts"))).toBe("transport");
    // Posix-style relative paths classify the same way.
    expect(firstPathSegment("codex/responses/adapter.ts")).toBe("codex");
    expect(firstPathSegment("anthropic/gateway.ts")).toBe("anthropic");
  });

  it("flags variable-argument and interpolated module dependencies as computed", () => {
    expect(nonStaticDependencies(`
      const p = "../../codex/x.js";
      await import(p);
      const r = require(target);
      const cr = createRequire(import.meta.url)(target);
      const dyn = import(\`../\${name}.js\`);
    `).map((dependency) => dependency.syntax)).toEqual([
      "import(identifier)",
      "require(identifier)",
      "createRequire(identifier)",
      "import(templateexpression)",
    ]);
  });

  it("never flags static literal or no-substitution template specifiers as computed", () => {
    expect(nonStaticDependencies(`
      const a = import("./a.js");
      const b = require(\`../b.js\`);
      const cr = createRequire(import.meta.url)("./c.js");
      import { E } from "./e.js";
    `)).toEqual([]);
  });

  it("allows only the two shared Anthropic modules across both path styles", () => {
    for (const rel of [
      "anthropic/protocol.js",
      "anthropic/passthrough.js",
      "anthropic\\protocol.js",
      "anthropic\\passthrough.js",
    ]) {
      expect(isSharedAnthropicModule(rel)).toBe(true);
    }
    for (const rel of [
      "anthropic/native.js",
      "anthropic/gateway.js",
      "anthropic/claude-context.js",
      "anthropic/index.js",
    ]) {
      expect(isSharedAnthropicModule(rel)).toBe(false);
    }
  });
});
