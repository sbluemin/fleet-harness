#!/usr/bin/env node
/**
 * Every child process the product starts must hide its window on Windows.
 *
 * Console runs detached, without a console of its own. A console-subsystem child (powershell, git, node, an Agent CLI)
 * started without `windowsHide: true` therefore gets a fresh, visible console window — a flash the user sees each time
 * a quota lookup or version probe runs. The bug is invisible on macOS and Linux, so only a static gate keeps it fixed.
 *
 * A call into `node:child_process` passes when one of its arguments is `withHidden(...)` or an object literal carrying
 * `windowsHide: true`. Anything this check cannot decide — no options, a variable, a bare spread, or the function handed
 * on as a reference — is a violation. A deliberate exception (for example a foreground child that inherits the user's
 * terminal, where libuv ignores `windowsHide`) carries `// fleet-allow-visible-spawn: <reason>` on the line directly
 * above it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODULES = new Set(["node:child_process", "child_process"]);
const LAUNCHERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "tests", "test", "__tests__", "fixtures", "__fixtures__", "scripts", "probe", "probes"]);
const ALLOW_MARKER = /\/\/\s*fleet-allow-visible-spawn:\s*\S/;

function productRoots() {
  const roots = ["foundation", "features", "core", "cli"].map((part) => path.join(repoRoot, "runtime/fleet-console", part));
  const plugins = path.join(repoRoot, "runtime/fleet-plugins");
  for (const entry of safeReaddir(plugins)) roots.push(path.join(plugins, entry, "server"));
  roots.push(path.join(repoRoot, "runtime/fleet-desktop/src"));
  return roots;
}

function safeReaddir(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function walk(directory, files = []) {
  for (const entry of safeReaddir(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry)) || entry.endsWith(".d.ts")) continue;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry) || entry.startsWith("postinstall.")) continue;
    files.push(full);
  }
  return files;
}

function isModuleSpecifier(node) {
  return node && ts.isStringLiteralLike(node) && MODULES.has(node.text);
}

function isRequireOfModule(node) {
  return node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && isModuleSpecifier(node.arguments[0]);
}

function isPromisify(node) {
  const callee = node.expression;
  return (ts.isIdentifier(callee) && callee.text === "promisify") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "promisify");
}

function hidesWindow(argument) {
  if (ts.isCallExpression(argument)) {
    const callee = argument.expression;
    return (ts.isIdentifier(callee) && callee.text === "withHidden") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "withHidden");
  }
  if (ts.isParenthesizedExpression(argument) || ts.isAsExpression(argument) || ts.isSatisfiesExpression?.(argument)) return hidesWindow(argument.expression);
  if (!ts.isObjectLiteralExpression(argument)) return false;
  return argument.properties.some((property) => ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "windowsHide"
    && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

function isTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeAliasDeclaration(current) || ts.isInterfaceDeclaration(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

export function checkSource(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines = text.split(/\r?\n/);
  const launchers = new Map(); // local name -> launcher kind
  const namespaces = new Set();
  const declarations = new Set(); // binding identifiers that introduced a tracked name
  const violations = [];

  const collect = (node) => {
    if (ts.isImportDeclaration(node) && isModuleSpecifier(node.moduleSpecifier) && node.importClause && !node.importClause.isTypeOnly) {
      const clause = node.importClause;
      if (clause.name) { namespaces.add(clause.name.text); declarations.add(clause.name); }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) { namespaces.add(bindings.name.text); declarations.add(bindings.name); }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (element.isTypeOnly || !LAUNCHERS.has(imported)) continue;
          launchers.set(element.name.text, imported);
          declarations.add(element.name);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isRequireOfModule(node.initializer)) {
      if (ts.isIdentifier(node.name)) { namespaces.add(node.name.text); declarations.add(node.name); }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = (element.propertyName ?? element.name).getText(source);
          if (!ts.isIdentifier(element.name) || !LAUNCHERS.has(imported)) continue;
          launchers.set(element.name.text, imported);
          declarations.add(element.name);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  // A tracked launcher expression: `spawn`, `cp.spawn`, or `promisify(spawn)`.
  const launcherOf = (expression) => {
    if (ts.isParenthesizedExpression(expression)) return launcherOf(expression.expression);
    if (ts.isIdentifier(expression)) return launchers.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text) && LAUNCHERS.has(expression.name.text)) return expression.name.text;
    if (ts.isCallExpression(expression) && isPromisify(expression) && expression.arguments.length === 1) return launcherOf(expression.arguments[0]);
    return undefined;
  };

  // `const run = promisify(execFile)` makes `run` a launcher too. Repeat until no new binding appears.
  for (let grew = true; grew;) {
    grew = false;
    const bind = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && isPromisify(node.initializer)) {
        const kind = launcherOf(node.initializer);
        if (kind && !launchers.has(node.name.text)) { launchers.set(node.name.text, kind); declarations.add(node.name); grew = true; }
      }
      ts.forEachChild(node, bind);
    };
    bind(source);
  }

  const allowed = (node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    return line > 0 && ALLOW_MARKER.test(lines[line - 1]);
  };
  const report = (node, message) => {
    if (allowed(node)) return;
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({ line: line + 1, column: character + 1, message });
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const kind = launcherOf(node.expression);
      if (kind) {
        if (!node.arguments.slice(1).some(hidesWindow)) report(node, `${kind}() without windowsHide: true or withHidden(...)`);
        // The callee itself is a sanctioned use; only its arguments still need a look.
        for (const argument of node.arguments) visit(argument);
        return;
      }
      // `promisify(launcher)` is a binding, not a call; the launcher reference inside it is sanctioned.
      if (isPromisify(node) && node.arguments.length === 1 && launcherOf(node.arguments[0])) {
        const parent = node.parent;
        const bound = ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name);
        const invoked = ts.isCallExpression(parent) && parent.expression === node;
        if (!bound && !invoked) report(node, `promisify(${launcherOf(node.arguments[0])}) handed on without a direct call`);
        return;
      }
    }
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && !declarations.has(node) && !isTypePosition(node)) {
      const parent = node.parent;
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)
        || ts.isBindingElement(parent) || (ts.isMethodDeclaration(parent) && parent.name === node) || (ts.isPropertyDeclaration(parent) && parent.name === node);
      if (!isPropertyName) {
        if (launchers.has(node.text)) report(node, `${launchers.get(node.text)} referenced without a direct call`);
        else if (namespaces.has(node.text)) {
          const member = ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : undefined;
          if (member === undefined || LAUNCHERS.has(member)) report(node, `child_process ${member ?? "module"} referenced without a direct call`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function main() {
  const violations = [];
  for (const root of productRoots()) {
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("child_process")) continue;
      for (const violation of checkSource(file, text)) violations.push(`${path.relative(repoRoot, file)}:${violation.line}:${violation.column} ${violation.message}`);
    }
  }
  if (violations.length > 0) {
    console.error("Child processes must hide their window on Windows. Add windowsHide: true (or withHidden(...)) to the options,");
    console.error("or mark a deliberate exception with `// fleet-allow-visible-spawn: <reason>` on the line above.\n");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log("windows-hidden-spawn: every product child process hides its window.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
