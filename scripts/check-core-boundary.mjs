import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const consoleRoot = path.join(repoRoot, "runtime/fleet-console");
const foundation = path.join(consoleRoot, "foundation");
const violations = [];
const permitted = new Set(["@fleet-console/agent-runtime", "@fleet-console/process", "@fleet-console/infra", "@fleet-console/markdown", "@fleet-console/font-picker", "@fleet-console/sdk", "@fleet-console/protocol"]);

function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "build", "coverage"].includes(entry.name)) return [];
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function report(file, message) { violations.push(`${path.relative(repoRoot, file)}: ${message}`); }
function checkSpecifier(file, specifier) {
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(file), specifier);
    const substrate = path.join(foundation, "agent-runtime/src");
    if (["tools", "mcp", "claude"].some((part) => file.startsWith(path.join(substrate, part) + path.sep)) && target.startsWith(path.join(substrate, "fleet") + path.sep)) report(file, `substrate imports Fleet policy: ${specifier}`);
    if (!target.startsWith(foundation + path.sep) && !target.startsWith(path.join(consoleRoot, "sdk") + path.sep) && !target.startsWith(path.join(consoleRoot, "protocol") + path.sep)) report(file, `foundation reaches outside its dependencies: ${specifier}`);
  } else if (specifier.startsWith("@fleet-") || specifier.startsWith("@dotobokuri/")) {
    const name = specifier.split("/").slice(0, 2).join("/");
    if (!permitted.has(name)) report(file, `foundation imports ${specifier}`);
    else if (/\/(src|internal)\//.test(specifier)) report(file, `private source import: ${specifier}`);
  }
}
if (!existsSync(foundation)) report(foundation, "foundation directory is missing");
for (const file of files(foundation)) {
  // Gateway integration fixtures belong with the consuming feature, never the substrate suite.
  if (file.endsWith("package.json")) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) checkSpecifier(file, name);
    }
  }
  if (!/\.(?:[cm]?ts|tsx)$/.test(file) || file.endsWith(".d.ts")) continue;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkSpecifier(file, node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) checkSpecifier(file, node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) checkSpecifier(file, node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const file of files(path.join(repoRoot, "packages"))) {
  if (/\.(?:[cm]?ts|tsx|json)$/.test(file)) report(file, "retired root packages tree still contains source or a manifest");
}
if (violations.length) {
  console.error("Console foundation boundary violations:\n" + violations.map((v) => `- ${v}`).join("\n"));
  process.exitCode = 1;
} else console.log("Console foundation boundary passed");
