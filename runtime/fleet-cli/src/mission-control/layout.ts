import { truncateToWidth, visibleWidth } from "../controls/index.js";

export interface ChoiceBlockRow {
  readonly label: string;
  readonly marker: string;
  readonly trailing?: string;
}

export interface KeyValueBlockRow {
  readonly key: string;
  readonly value: string;
}

export function maxVisibleWidth(texts: readonly string[]): number {
  let maxWidth = 0;
  for (const text of texts) {
    maxWidth = Math.max(maxWidth, visibleWidth(text));
  }
  return maxWidth;
}

export function padEndVisible(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

export function computeBlockLeftPad(blockWidth: number, innerWidth: number): number {
  return Math.max(0, Math.floor((Math.max(0, innerWidth) - Math.max(0, blockWidth)) / 2));
}

export function renderChoiceBlock(options: {
  readonly innerWidth: number;
  readonly rows: readonly ChoiceBlockRow[];
}): string[] {
  const labelWidth = maxVisibleWidth(options.rows.map((row) => row.label));
  const rowTexts = options.rows.map((row) => formatChoiceRow(row, labelWidth));
  const blockWidth = maxVisibleWidth(rowTexts);
  const leftPad = computeBlockLeftPad(blockWidth, options.innerWidth);
  const rowWidth = Math.max(0, options.innerWidth - leftPad);
  return rowTexts.map((row) => `${" ".repeat(leftPad)}${truncateToWidth(row, rowWidth)}`);
}

export function renderKeyValueBlock(options: {
  readonly innerWidth: number;
  readonly rows: readonly KeyValueBlockRow[];
}): string[] {
  const keyWidth = maxVisibleWidth(options.rows.map((row) => row.key));
  const rowTexts = options.rows.map((row) => `${padEndVisible(row.key, keyWidth)}: ${row.value}`);
  const blockWidth = maxVisibleWidth(rowTexts);
  const leftPad = computeBlockLeftPad(blockWidth, options.innerWidth);
  const rowWidth = Math.max(0, options.innerWidth - leftPad);
  return rowTexts.map((row) => `${" ".repeat(leftPad)}${truncateToWidth(row, rowWidth)}`);
}

function formatChoiceRow(row: ChoiceBlockRow, labelWidth: number): string {
  const label = padEndVisible(row.label, labelWidth);
  return row.trailing === undefined ? `${row.marker} ${label}` : `${row.marker} ${label}  ${row.trailing}`;
}
