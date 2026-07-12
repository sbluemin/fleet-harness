import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeExports = [
  "DESKTOP_DEVELOPMENT_ENV",
  "DESKTOP_OWNER_ID_ENV",
  "DESKTOP_OWNER_KIND_ENV",
  "DESKTOP_PROTOCOL_VERSION",
  "DESKTOP_PROTOCOL_VERSION_ENV",
  "DESKTOP_RESOURCE_ROOT_ENV",
  "DESKTOP_RESOURCE_ROOT_MARKER",
  "isCompatibleDesktopOwner",
  "isDesktopDevelopmentEnvironment",
  "readDesktopProtocolEnvironment",
  "resolveCanonicalLocalConsolePaths",
  "resolveCanonicalStableConsolePaths",
  "validateDesktopDevelopmentResourceRoot",
  "validateDesktopResourceRoot",
];
const declarationExports = [
  ...runtimeExports,
  "CanonicalConsolePaths",
  "ConsoleOwnerKind",
  "ConsoleOwnerMetadata",
  "DesktopProtocolEnvironment",
  "DesktopProtocolValidationDeps",
  "ResolveCanonicalConsolePathsInput",
  "ResolveCanonicalLocalConsolePathsInput",
];

const protocol = await import(pathToFileURL(path.join(__dirname, "dist", "desktop-protocol.mjs")).href);
assertExactExports("runtime", Object.keys(protocol), runtimeExports);

const declaration = await readFile(path.join(__dirname, "dist", "desktop-protocol.d.ts"), "utf8");
if (declaration.includes("workspace:") || declaration.includes("@fleet-console/desktop-protocol")) {
  throw new Error("desktop_protocol_compatibility_declaration_workspace_import");
}
const declarationExport = [...declaration.matchAll(/export \{([^}]*)\};/gs)].at(-1)?.[1];
if (declarationExport === undefined) throw new Error("desktop_protocol_compatibility_declaration_exports_missing");
assertExactExports("declaration", declarationExport.split(",").map((entry) => entry.trim().replace(/^type\s+/, "")), declarationExports);

function assertExactExports(kind, actual, expected) {
  const actualNames = [...actual].sort();
  const expectedNames = [...expected].sort();
  if (actualNames.length === expectedNames.length && actualNames.every((name, index) => name === expectedNames[index])) return;
  throw new Error(`desktop_protocol_compatibility_${kind}_exports_changed: expected ${expectedNames.join(",")}; received ${actualNames.join(",")}`);
}
