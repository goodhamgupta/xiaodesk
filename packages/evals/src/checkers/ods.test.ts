import { describe, expect, it } from 'vitest';
import { gradeWorkbook, normFormula, parseSheets } from './ods.js';

const content = `
<table:table table:name="Sales">
<table:table-row>
<table:table-cell office:value-type="string"><text:p>Region</text:p></table:table-cell>
<table:table-cell table:number-columns-repeated="3"/>
</table:table-row>
<table:table-row>
<table:table-cell/><table:table-cell/><table:table-cell/><table:table-cell/>
<table:table-cell table:formula="of:=C2*D2" office:value-type="float" office:value="880"/>
</table:table-row>
<table:table-row table:number-rows-repeated="12"/>
<table:table-row>
<table:table-cell table:number-columns-repeated="6"/>
<table:table-cell table:formula="of:=SUM(G2:G13)" office:value-type="float" office:value="6205.4"/>
</table:table-row>
</table:table>
<table:table table:name="Summary">
<table:table-row table:number-rows-repeated="1"/>
<table:table-row>
<table:table-cell/>
<table:table-cell table:formula="of:=SUMIF($Sales.$A$2:$Sales.$A$13;&quot;North&quot;;$Sales.$G$2:$Sales.$G$13)" office:value-type="float" office:value="1812.4"/>
</table:table-row>
</table:table>`;

const settings = `
<config:config-item config:name="VerticalSplitMode" config:type="short">2</config:config-item>
<config:config-item config:name="VerticalSplitPosition" config:type="short">1</config:config-item>`;

const styles = `<number:currency-style style:name="N108"><number:currency-symbol>$</number:currency-symbol></number:currency-style>`;

describe('ods workbook grader', () => {
  it('normalizes LibreOffice formula syntax', () => {
    expect(normFormula('of:=SUMIF($Sales.$A$2:$Sales.$A$13;"North";$Sales.$G$2:$Sales.$G$13)')).toBe(
      'SUMIF(SALES.A2:A13,"NORTH",SALES.G2:G13)',
    );
  });

  it('addresses cells after repeated rows and columns', () => {
    const sheets = parseSheets(content);
    expect(sheets.get('Sales')?.get('E2')?.formula).toBe('of:=C2*D2');
    expect(sheets.get('Sales')?.get('E2')?.value).toBe(880);
    expect(sheets.get('Sales')?.get('G15')?.formula).toBe('of:=SUM(G2:G13)');
    expect(sheets.get('Summary')?.get('B2')?.value).toBe(1812.4);
  });

  it('passes a frozen currency workbook and reports a bad formula', () => {
    const ok = gradeWorkbook(
      { content, settings, styles },
      {
        sheets: ['Sales', 'Summary'],
        freeze_header: true,
        styles_contain: ['currency'],
        formulas: [
          { sheet: 'Sales', cell: 'E2', contains: 'C2*D2', value: 880 },
          { sheet: 'Sales', cell: 'G15', contains: 'SUM(G2:G13)', value: 6205.4 },
          { sheet: 'Summary', cell: 'B2', contains: 'SUMIF(Sales.A2:A13,"North",Sales.G2:G13)', value: 1812.4 },
        ],
      },
    );
    expect(ok).toEqual([]);

    const bad = gradeWorkbook(
      { content, settings, styles },
      {
        sheets: ['Sales', 'Pivot'],
        formulas: [{ sheet: 'Sales', cell: 'E2', contains: 'C2+D2' }],
      },
    );
    expect(bad.some((error) => error.includes('missing sheet Pivot'))).toBe(true);
    expect(bad.some((error) => error.includes('E2'))).toBe(true);
  });
});
