// Read-only characterization of the current import rules; no app server or show data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import XLSX from 'xlsx';
import {DOMParser} from '@xmldom/xmldom';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('function htmlDocument('), source.indexOf('/* ---- client HTML'));
let id = 0;
const context = vm.createContext({ XLSX, DOMParser, uid: prefix => prefix + (++id) });
vm.runInContext(section + '\nglobalThis.parsers = { extractHtmlTables, parseSheet, textToTables };', context);
const { extractHtmlTables, parseSheet, textToTables } = context.parsers;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxflow-import-audit-'));
const files = [];
function sheet(name, rows, configure = () => {}, options = {}) {
  const file = path.join(dir, name); files.push(file);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows); configure(worksheet);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Cues');
  XLSX.writeFile(workbook, file);
  return parseSheet(file, options)[0];
}
try {
  const duplicate = sheet('duplicate.xlsx', [['Notes', 'Notes'], ['audio note', 'lighting note']]);
  const reserved = sheet('reserved.xlsx', [['ID', 'Action'], ['customer cue identifier', 'GO']]);
  const time = sheet('time.xlsx', [['Time', 'Action'], [0.5, 'Lunch']], ws => { ws.A2.z = 'h:mm AM/PM'; });
  const entities = extractHtmlTables('<table><tr><th>Action</th></tr><tr><td>Tom &amp; Jerry<br>GO</td></tr></table>')[0];
  const headerless = sheet('headerless.xlsx', [['09:00', 'Doors open'], ['09:30', 'Welcome']]);
  const offset = sheet('offset.xlsx', [['Personnel', 'Details'], ['Name', 'Dom'], ['Line #', 'Action'], [1, 'GO']], () => {}, { startRow: 3 });
  const weekdays = textToTables('Preset lighting\nMonday rehearsal\nA2 - Mic talent');
  const normalize = tables => JSON.stringify(tables, (key, value) => key === 'id' ? undefined : value);
  const repeatA = textToTables('A2 - Mic talent\nLX - House out');
  const repeatB = textToTables('A2 - Mic talent\nLX - House out');
  const report = {
    duplicateHeaders: { columns: duplicate.columns, row: duplicate.rows[0], preservesBoth: Object.values(duplicate.rows[0]).includes('audio note') && Object.values(duplicate.rows[0]).includes('lighting note') },
    reservedIdHeader: { row: reserved.rows[0], overwritesCueId: reserved.rows[0].id === 'customer cue identifier' },
    spreadsheetTime: { expectedDisplay: '12:00 PM', actual: time.rows[0].time },
    wordEntitiesAndLineBreaks: { expected: 'Tom & Jerry\nGO', actual: entities.rows[0].action },
    headerlessSheet: { inputRows: 2, importedRows: headerless.rows.length, columns: headerless.columns },
    startingRow: { requestedRow: 3, importedColumns: offset.columns, importedRows: offset.rows.length },
    weekdayFalsePositive: { tables: weekdays, losesPreamble: !JSON.stringify(weekdays).includes('Preset lighting') },
    repeatTextImport: { rawEqual: JSON.stringify(repeatA) === JSON.stringify(repeatB), normalizedContentEqual: normalize(repeatA) === normalize(repeatB) },
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const file of files) fs.unlinkSync(file);
  fs.rmdirSync(dir);
}
