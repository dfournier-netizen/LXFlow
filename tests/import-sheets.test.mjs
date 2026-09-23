import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import XLSX from 'xlsx';

const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
let id=0;
const ctx=vm.createContext({XLSX,uid:()=>`cue_${++id}`});
vm.runInContext(source.slice(source.indexOf('function extractHtmlTables('),source.indexOf('/* ---- client HTML'))+'\nglobalThis.parse=parseSheet;',ctx);
test('sheet times, physical header rows, duplicate headers and internal IDs survive import',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lxflow-sheet-test-'));
  const file=path.join(dir,'example.xlsx');
  try {
    const wb=XLSX.utils.book_new();
    const ws=XLSX.utils.aoa_to_sheet([['Personnel'],[],['Start Time','TRT','Notes','Notes','ID'],[6.5/24,25/24,'Audio','LX','source-1']]);
    ws.A4.z='h:mm:ss AM/PM'; ws.B4.z='[h]:mm:ss';
    XLSX.utils.book_append_sheet(wb,ws,'Show'); XLSX.writeFile(wb,file);
    const table=ctx.parse(file,{startRow:3})[0];
    assert.equal(table.rows.length,1);
    assert.deepEqual(Array.from(table.sourceRows),[4]);
    assert.equal(table.rows[0].start_time,'6:30:00 AM');
    assert.equal(table.rows[0].trt,'25:00:00');
    assert.equal(table.rows[0].notes,'Audio'); assert.equal(table.rows[0].notes_2,'LX');
    assert.equal(table.rows[0].id_2,'source-1'); assert.match(table.rows[0].id,/^cue_/);
    assert.throws(()=>ctx.parse(file,{startRow:1.5}),/whole number/);
    assert.equal(ctx.parse(file,{startRow:999})[0].rows.length,0);
  } finally { if(fs.existsSync(file))fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('CSV and TSV preserve literal times, leading zeros and fractional source text',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lxflow-csv-test-'));
  try {
    for (const [ext,separator] of [['csv',','],['tsv','\t']]) {
      const file=path.join(dir,`show.${ext}`);
      fs.writeFileSync(file,[['Cue','Start Time','End Time','TRT','Numeric Duration'],['001','06:30:00','7:45 PM','00:05:30','0.00381944444444444']].map(r=>r.join(separator)).join('\n'));
      const table=ctx.parse(file)[0];
      assert.equal(table.rows[0].cue,'001');
      assert.equal(table.rows[0].start_time,'06:30:00');
      assert.equal(table.rows[0].end_time,'7:45 PM');
      assert.equal(table.rows[0].trt,'00:05:30');
      assert.equal(table.rows[0].numeric_duration,'0.00381944444444444');
      assert.ok(table.warnings.some(w=>w.includes('Numeric Duration')));
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('sheet imports retain extra-width cells, errors and headerless first row without guessing numeric units',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lxflow-grid-test-'));
  try {
    const file=path.join(dir,'show.xlsx');
    const wb=XLSX.utils.book_new();
    const ws=XLSX.utils.aoa_to_sheet([['Start Time','TRT'],[0.5,1.5,'Unheaded extra'],[0.75,0.02,'Formula error']]);
    ws.D3={t:'e',v:7}; ws['!ref']='A1:D3';
    XLSX.utils.book_append_sheet(wb,ws,'Show'); XLSX.writeFile(wb,file);
    const table=ctx.parse(file)[0];
    assert.equal(table.columns.length,4);
    assert.equal(table.rows[0].col2,'Unheaded extra');
    assert.equal(table.rows[1].col3,'#DIV/0!');
    assert.equal(table.rows[0].start_time,'0.5');
    assert.equal(table.rows[0].trt,'1.5');
    assert.equal(table.warnings.length,3);
    const noHeader=ctx.parse(file,{hasHeader:false})[0];
    assert.equal(noHeader.rows.length,3);
    assert.equal(noHeader.rows[0].column_1,'Start Time');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
