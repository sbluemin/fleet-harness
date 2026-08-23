import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

import { describe, expect, it } from "vitest";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The two direction axes, and the two halves of the downstream one. */
const DOWNSTREAM_ROOT = "downstream";
const UPSTREAM_ROOT = "upstream";
const WIRE_ROOT = "downstream/wire/anthropic-messages";
const HARNESS_ROOT = "downstream/harness";

/**
 * Every upstream folder. `anthropic` is the native passthrough and declares no request
 * policy — it carries no gateway target, so the caller's request is forwarded byte for
 * byte and never reaches a policy.
 */
const UPSTREAM_FOLDERS = [
  "anthropic",
  "antigravity",
  "codex",
  "cursor",
  "kimi",
  "opencode-go",
  "xai",
] as const;

/** The upstreams a gateway model can name, each of which must declare its own policy. */
const GATEWAY_PROVIDER_FOLDERS = [
  "antigravity",
  "codex",
  "cursor",
  "kimi",
  "opencode-go",
  "xai",
] as const;

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

/** The two inbound-wire modules an upstream provider may import. */
const SHARED_WIRE_MODULES = new Set([
  "downstream/wire/anthropic-messages/protocol.js",
  "downstream/wire/anthropic-messages/passthrough.js",
  "downstream/wire/anthropic-messages/protocol.ts",
  "downstream/wire/anthropic-messages/passthrough.ts",
]);

/**
 * True when a `src`-relative path targets one of the shared inbound-wire modules.
 * `inbound.ts` is the translator the router owns, and everything under
 * `downstream/harness/` is one client's dialect — neither is a shared allowlist entry.
 */
function isSharedWireModule(srcRelativePath: string): boolean {
  return SHARED_WIRE_MODULES.has(srcRelativePath.split(/[\\/]/).join("/"));
}

/** The one router module an upstream provider folder may reach, and only for its types. */
const PROVIDER_POLICY_CONTRACT = new Set([
  "router/request-policy.js",
  "router/request-policy.ts",
]);

/**
 * Static import declarations with their type-only flag, for the seam-direction check.
 *
 * A provider declaring its own router policy has to name the contract it implements,
 * which is the one dependency pointing back at the serving seam. Restricting it to
 * `import type` keeps that edge erased at runtime, so the seam still owns every real
 * module the providers hang off.
 */
function importDeclarations(text: string): ReadonlyArray<{ specifier: string; typeOnly: boolean }> {
  const sourceFile = ts.createSourceFile(
    "probe.ts",
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const declarations: Array<{ specifier: string; typeOnly: boolean }> = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !isStaticSpecifier(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    const typeOnly = clause?.isTypeOnly === true
      || (named !== undefined
        && ts.isNamedImports(named)
        && named.elements.length > 0
        && named.elements.every((element) => element.isTypeOnly));
    declarations.push({ specifier: statement.moduleSpecifier.text, typeOnly });
  }
  return declarations;
}

function providerOf(file: string): string | undefined {
  const segments = path.relative(srcDir, file).split(/[\\/]/);
  if (segments[0] !== UPSTREAM_ROOT) return undefined;
  const folder = segments[1];
  return folder !== undefined && (UPSTREAM_FOLDERS as readonly string[]).includes(folder)
    ? folder
    : undefined;
}

/** A `src`-relative path, always `/`-joined, for comparison against the path constants above. */
function srcRelative(file: string): string {
  return path.relative(srcDir, file).split(/[\\/]/).join("/");
}

/** True when a `src`-relative path sits under the given axis root. */
function isUnder(srcRelativePath: string, root: string): boolean {
  return srcRelativePath === root || srcRelativePath.startsWith(`${root}/`);
}

describe("core-ai-gateway direction boundaries", () => {
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

  it("keeps the pivot and transport free of either direction", () => {
    // `canonical/` is what downstream and upstream both speak, and `transport/` is
    // direction-unaware mechanics. Either one reaching a direction folder would make the
    // pivot pick a side.
    for (const file of listTsFiles(srcDir)) {
      const rel = srcRelative(file);
      const first = firstPathSegment(rel);
      if (first !== "canonical" && first !== "transport") continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!isWithin(srcDir, resolved)) continue;
        const target = firstPathSegment(srcRelative(resolved));
        expect(
          target === DOWNSTREAM_ROOT || target === UPSTREAM_ROOT,
          `${rel} imports ${specifier} — ${first}/ must not reach ${target}/`,
        ).toBe(false);
      }
    }
  });

  it("keeps the inbound wire free of any harness dialect", () => {
    // The wire serves every client that speaks it. A harness fact reaching in here —
    // an id grammar, a context coordinate, a retry ladder — is what made this package
    // single-client, and it is the one edge a second harness cannot work around.
    for (const file of listTsFiles(srcDir)) {
      const rel = srcRelative(file);
      if (!isUnder(rel, WIRE_ROOT)) continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!isWithin(srcDir, resolved)) continue;
        expect(
          isUnder(srcRelative(resolved), HARNESS_ROOT),
          `${rel} imports ${specifier} — the wire must not know which harness it is serving`,
        ).toBe(false);
      }
    }
  });

  it("keeps each upstream provider from importing another upstream provider", () => {
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      const owner = providerOf(file);
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

  it("lets the inbound wire reach upstream only for the gateway's default adapter", () => {
    for (const file of listTsFiles(srcDir)) {
      const rel = srcRelative(file);
      if (!isUnder(rel, DOWNSTREAM_ROOT)) continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        const target = isWithin(srcDir, resolved) ? providerOf(resolved) : undefined;
        if (target === undefined) continue;
        // Sanctioned compatibility exception: AnthropicMessagesGateway's backwards-
        // compatible default constructor imports OpenAIResponsesAdapter from
        // upstream/codex/responses/adapter.js. Anything else downstream→upstream is a violation.
        const isGatewayDefault = rel === `${WIRE_ROOT}/inbound.ts`
          && srcRelative(resolved) === "upstream/codex/responses/adapter.js";
        expect(isGatewayDefault, `${rel} imports upstream folder ${target}`).toBe(true);
      }
    }
  });

  it("lets an upstream provider borrow only the shared inbound wire modules", () => {
    // The two providers whose upstream wire IS the downstream wire — Kimi and OpenCode
    // Go's Anthropic models — relay a caller request without translating it, so they
    // speak the same normalization. Nothing else downstream is shared: a harness dialect
    // is never an upstream concern.
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      if (providerOf(file) === undefined) continue;
      for (const specifier of specifiersOf(file)) {
        if (!isRelative(specifier)) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!isWithin(srcDir, resolved)) continue;
        const target = srcRelative(resolved);
        if (!isUnder(target, DOWNSTREAM_ROOT)) continue;
        expect(
          isSharedWireModule(target),
          `${rel} imports ${specifier} — only ${[...SHARED_WIRE_MODULES].join(" and ")} are shared`,
        ).toBe(true);
      }
    }
  });

  it("lets an upstream provider reach the router only for the policy contract, type-only", () => {
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      if (providerOf(file) === undefined) continue;
      for (const declaration of importDeclarations(readFileSync(file, "utf8"))) {
        if (!isRelative(declaration.specifier)) continue;
        const resolved = path.resolve(path.dirname(file), declaration.specifier);
        if (!isWithin(srcDir, resolved)) continue;
        const target = srcRelative(resolved);
        if (firstPathSegment(target) !== "router") continue;
        expect(
          PROVIDER_POLICY_CONTRACT.has(target),
          `${rel} imports ${declaration.specifier} — router/request-policy.js is the only module a provider may reach`,
        ).toBe(true);
        expect(
          declaration.typeOnly,
          `${rel} imports ${declaration.specifier} as a value — the policy contract must stay an \`import type\``,
        ).toBe(true);
      }
    }
  });

  it("gives every gateway provider exactly one request policy", () => {
    for (const provider of GATEWAY_PROVIDER_FOLDERS) {
      expect(
        existsSync(path.join(srcDir, UPSTREAM_ROOT, provider, "request-policy.ts")),
        `${provider} declares no request policy — a provider without one would inherit another provider's answer`,
      ).toBe(true);
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

  it("owns all three OpenCode wire implementations under upstream/opencode-go", () => {
    for (const rel of [
      "upstream/opencode-go/anthropic/index.ts",
      "upstream/opencode-go/responses/adapter.ts",
      "upstream/opencode-go/chat-completions/adapter.ts",
    ]) {
      expect(existsSync(path.join(srcDir, rel)), rel).toBe(true);
    }
  });

  it("keeps every axis folder at its own root", () => {
    // Pins the direction split itself: the pre-split spellings must not come back, and
    // each axis root must exist. A provider folder re-appearing at `src/` would put an
    // upstream beside the pivot again, which is what `providerOf` stops being able to see.
    for (const gone of [
      "anthropic",
      "gateway-router",
      "antigravity",
      "codex",
      "cursor",
      "kimi",
      "opencode-go",
      "xai",
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
      expect(existsSync(path.join(srcDir, gone)), gone).toBe(false);
    }
    for (const root of [DOWNSTREAM_ROOT, UPSTREAM_ROOT, WIRE_ROOT, HARNESS_ROOT, "router", "canonical", "transport"]) {
      expect(existsSync(path.join(srcDir, root)), root).toBe(true);
    }
  });

  it("keeps cursor exec-responses and exec-redirect internal to the cursor folder", () => {
    // The only path from the root facade to those modules is the cursor/native barrel,
    // so pinning the barrel means CursorClientToolReference, CursorUnknownExecReply,
    // cursorNativeExecPolicyReplies, cursorNativeExecRedirect, cursorUnknownExecCaseName,
    // and cursorUnknownExecReply stay out of the package-level public surface.
    const nativeIndexSpecifiers = moduleSpecifiers(
      readFileSync(path.join(srcDir, UPSTREAM_ROOT, "cursor", "native", "index.ts"), "utf8"),
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

  it("allows only the two shared inbound-wire modules across both path styles", () => {
    for (const rel of [
      "downstream/wire/anthropic-messages/protocol.js",
      "downstream/wire/anthropic-messages/passthrough.js",
      "downstream\\wire\\anthropic-messages\\protocol.js",
      "downstream\\wire\\anthropic-messages\\passthrough.js",
    ]) {
      expect(isSharedWireModule(rel)).toBe(true);
    }
    for (const rel of [
      "downstream/wire/anthropic-messages/inbound.js",
      "downstream/harness/contract.js",
      "downstream/harness/claude-code/context.js",
      "downstream/harness/claude-code/discovery.js",
      "downstream/harness/claude-code/profile.js",
      "upstream/anthropic/native.js",
    ]) {
      expect(isSharedWireModule(rel)).toBe(false);
    }
  });
});
