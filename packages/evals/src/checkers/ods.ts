import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface OdsFormulaExpect {
  sheet: string;
  cell: string;
  contains?: string;
  value?: number;
  tolerance?: number;
}

export interface OdsExpect {
  sheets: string[];
  formulas: OdsFormulaExpect[];
  freeze_header?: boolean;
  styles_contain?: string[];
}

export interface OdsCell {
  formula?: string;
  value?: number;
}

export interface OdsParts {
  content: string;
  settings: string;
  styles: string;
}

export function normFormula(formula: string): string {
  let text = formula
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/^of:/i, '')
    .replace(/^=/, '')
    .replace(/;/g, ',')
    .replace(/\s+/g, '')
    .replace(/\$/g, '')
    .toUpperCase();
  text = text.replace(/([A-Z][A-Z0-9]*)\.([A-Z]+)(\d+):\1\.([A-Z]+)(\d+)/g, '$1.$2$3:$4$5');
  return text;
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`));
  if (!match) return undefined;
  return match[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function parseSheets(content: string): Map<string, Map<string, OdsCell>> {
  const sheets = new Map<string, Map<string, OdsCell>>();
  for (const chunk of content.split('<table:table ').slice(1)) {
    const headEnd = chunk.indexOf('>');
    if (headEnd === -1) continue;
    const name = attr(chunk.slice(0, headEnd), 'table:name') ?? 'Sheet';
    const body = chunk.split('</table:table>')[0] ?? chunk;
    const cells = new Map<string, OdsCell>();
    let row = 0;
    for (const rowChunk of body.split('<table:table-row').slice(1)) {
      const rowEnd = rowChunk.indexOf('>');
      if (rowEnd === -1) continue;
      const rowRepeat = Number(attr(rowChunk.slice(0, rowEnd), 'table:number-rows-repeated') ?? '1') || 1;
      const rowBody = rowChunk.slice(rowEnd + 1).split('</table:table-row>')[0] ?? '';
      let col = 0;
      const cellRe = /<table:(table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>)/g;
      let match: RegExpExecArray | null;
      while ((match = cellRe.exec(rowBody))) {
        const tag = match[2] ?? '';
        const repeat = Number(attr(tag, 'table:number-columns-repeated') ?? '1') || 1;
        const formula = attr(tag, 'table:formula');
        const rawValue = attr(tag, 'office:value');
        const value = rawValue === undefined ? undefined : Number(rawValue);
        for (let offset = 0; offset < repeat; offset += 1) {
          if (formula || rawValue !== undefined) {
            const info: OdsCell = {};
            if (formula) info.formula = formula;
            if (rawValue !== undefined && !Number.isNaN(value)) info.value = value;
            cells.set(`${columnName(col + offset)}${row + 1}`, info);
          }
        }
        col += repeat;
      }
      row += rowRepeat;
    }
    sheets.set(name, cells);
  }
  return sheets;
}

function findSheet(sheets: Map<string, Map<string, OdsCell>>, name: string): Map<string, OdsCell> | undefined {
  for (const [sheetName, cells] of sheets) {
    if (sheetName.toLowerCase() === name.toLowerCase()) return cells;
  }
  return undefined;
}

function styleHas(styles: string, token: string): boolean {
  const haystack = styles.toLowerCase();
  const needle = token.toLowerCase();
  if (needle === 'currency') return haystack.includes('currency');
  if (needle === 'percent' || needle === 'percentage') return haystack.includes('percentage') || haystack.includes('percent');
  return haystack.includes(needle);
}

export function gradeWorkbook(parts: OdsParts, expect: OdsExpect): string[] {
  const errors: string[] = [];
  const sheets = parseSheets(parts.content);
  const present = [...sheets.keys()];
  for (const name of expect.sheets) {
    if (!findSheet(sheets, name)) errors.push(`missing sheet ${name} (have ${present.join(', ') || 'none'})`);
  }
  for (const spec of expect.formulas) {
    const cell = findSheet(sheets, spec.sheet)?.get(spec.cell.toUpperCase());
    const where = `${spec.sheet}!${spec.cell}`;
    if (spec.contains) {
      const actual = cell?.formula ? normFormula(cell.formula) : '';
      const needle = normFormula(spec.contains);
      if (!actual.includes(needle)) {
        errors.push(`${where}: expected formula containing ${spec.contains}, got ${cell?.formula ?? 'empty'}`);
      }
    }
    if (spec.value !== undefined) {
      const actual = cell?.value;
      const tolerance = spec.tolerance ?? 0.05;
      if (actual === undefined || Math.abs(actual - spec.value) > tolerance) {
        errors.push(`${where}: expected value ${spec.value} (±${tolerance}), got ${actual ?? 'empty'}`);
      }
    }
  }
  if (expect.freeze_header) {
    const modes = [...parts.settings.matchAll(/config:name="VerticalSplitMode"[^>]*>\s*([^<]+)/g)].map((match) => match[1].trim());
    const positions = [...parts.settings.matchAll(/config:name="VerticalSplitPosition"[^>]*>\s*([^<]+)/g)].map((match) => Number(match[1].trim()));
    if (!modes.includes('2') && !positions.some((position) => position >= 1)) {
      errors.push(`header row is not frozen (VerticalSplitMode=${modes.join(',') || 'missing'}, VerticalSplitPosition=${positions.join(',') || 'missing'})`);
    }
  }
  for (const token of expect.styles_contain ?? []) {
    if (!styleHas(parts.styles, token)) errors.push(`styles.xml missing ${token} format`);
  }
  return errors;
}

export function readOds(source: Buffer | string): OdsParts {
  const dir = mkdtempSync(join(tmpdir(), 'ods-'));
  const file = join(dir, 'book.ods');
  try {
    if (typeof source === 'string') {
      return readOds(readFileSync(source));
    }
    writeFileSync(file, source);
    const unzip = (name: string): string => {
      try {
        return execFileSync('unzip', ['-p', file, name], { maxBuffer: 32_000_000 }).toString('utf8');
      } catch {
        return '';
      }
    };
    return { content: unzip('content.xml'), settings: unzip('settings.xml'), styles: unzip('styles.xml') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
