import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findLocalizedAttributeViolations } from "./check-localized-attributes.mjs";

const ROOTS = ["runtime/fleet-plugins"];

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "localized-attr-gate-"));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

test("catches the literal that shipped as aria-label=\"Terminal\"", () => {
  const root = fixture({ "runtime/fleet-plugins/x/panel.tsx": '<section aria-label="Terminal">\n' });
  assert.deepEqual(
    findLocalizedAttributeViolations(root, ROOTS),
    ['runtime/fleet-plugins/x/panel.tsx:1 aria-label="Terminal"'],
  );
});

test("accepts a value read through the translator", () => {
  const root = fixture({ "runtime/fleet-plugins/x/panel.tsx": '<section aria-label={t("terminal.aria")}>\n' });
  assert.deepEqual(findLocalizedAttributeViolations(root, ROOTS), []);
});

test("leaves identifiers and single glyphs alone — they are not the screen's words", () => {
  const root = fixture({
    "runtime/fleet-plugins/x/a.tsx": '<i title="▾" />\n<div placeholder="" />\n<b title="id" />\n',
  });
  assert.deepEqual(findLocalizedAttributeViolations(root, ROOTS), []);
});

test("catches a multi-word placeholder as well", () => {
  const root = fixture({ "runtime/fleet-plugins/x/a.tsx": '<input placeholder="search skills here" />\n' });
  assert.deepEqual(
    findLocalizedAttributeViolations(root, ROOTS),
    ['runtime/fleet-plugins/x/a.tsx:1 placeholder="search skills here"'],
  );
});

test("skips test files, which name the screen's words to find them", () => {
  const root = fixture({ "runtime/fleet-plugins/x/a.test.tsx": '<section aria-label="Terminal">\n' });
  assert.deepEqual(findLocalizedAttributeViolations(root, ROOTS), []);
});

test("skips build output", () => {
  const root = fixture({ "runtime/fleet-plugins/x/dist/a.tsx": '<section aria-label="Terminal">\n' });
  assert.deepEqual(findLocalizedAttributeViolations(root, ROOTS), []);
});
