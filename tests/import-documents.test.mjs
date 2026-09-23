import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DOMParser} from '@xmldom/xmldom';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
let id=0;
const ctx=vm.createContext({DOMParser,uid:()=>`cue_${++id}`});
vm.runInContext(source.slice(source.indexOf('function htmlDocument('),source.indexOf('/* ---- client HTML'))+'\nglobalThis.api={extractHtmlTables,extractHtmlDocument,textToTables};',ctx);

test('DOCX table HTML decodes entities, preserves paragraphs, and keeps reserved/duplicate headers separate',()=>{
  const [table]=ctx.api.extractHtmlTables('<table><tr><th>ID</th><th>Notes</th><th>Notes</th></tr><tr><td>source-id</td><td><p>Sound &amp; Light</p><p>Second &lt;line&gt;</p></td><td>&#169; &quot;show&quot;</td><td>Unheaded</td></tr></table>');
  assert.equal(table.rows[0].id_2,'source-id');
  assert.match(table.rows[0].id,/^cue_/);
  assert.equal(table.rows[0].notes,'Sound & Light\nSecond <line>');
  assert.equal(table.rows[0].notes_2,'© "show"');
  assert.equal(table.rows[0].col3,'Unheaded');
});

test('DOCX spans preserve grid positions and document prose around tables',()=>{
  const html='<p>Before table</p><table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td rowspan="2">Shared</td><td colspan="2">Wide</td></tr><tr><td>Lower B</td><td>Lower C</td></tr></table><p>After table</p>';
  const tables=ctx.api.extractHtmlDocument(html);
  assert.equal(tables.length,3);
  assert.equal(tables[0].rows[0].action,'Before table');
  assert.equal(tables[1].rows[0].a,'Shared');
  assert.equal(tables[1].rows[0].b,'Wide');
  assert.equal(tables[1].rows[1].a,'');
  assert.equal(tables[1].rows[1].b,'Lower B');
  assert.equal(tables[1].rows[1].c,'Lower C');
  assert.match(tables[1].warnings[0],/Merged/);
  assert.equal(tables[2].rows[0].action,'After table');
});

test('weekday prose does not trigger memo parser; actual memo preserves introduction',()=>{
  const prose=ctx.api.textToTables('Overview\nMonday meetings are useful\nBring a laptop');
  assert.equal(prose.length,1); assert.equal(prose[0].rows.length,3);
  const memo=ctx.api.textToTables('Production briefing\nTuesday, June 23\nOpening\nWho: AV\nTime: 9 AM');
  assert.equal(memo.length,2);
  assert.equal(memo[0].rows[0].action,'Production briefing');
  assert.equal(memo[1].rows[0].time,'9 AM');
});

import os from 'node:os';
import path from 'node:path';
import mammoth from 'mammoth';
import {ZipFile} from 'yazl';
const documentCtx=vm.createContext({DOMParser,mammoth,fs,path,uid:()=>`cue_${++id}`});
vm.runInContext(source.slice(source.indexOf('async function parseUpload('),source.indexOf('/* ---- client HTML'))+'\nglobalThis.parseDocument=parseUpload;',documentCtx);

test('real DOCX conversion preserves table entities and text before and after tables',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lxflow-docx-test-'));
  try {
    const file=path.join(dir,'show.docx');
    const zip=new ZipFile();
    zip.addBuffer(Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),'[Content_Types].xml');
    zip.addBuffer(Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),'_rels/.rels');
    const paragraph=text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const row=values=>`<w:tr>${values.map(text=>`<w:tc>${paragraph(text)}</w:tc>`).join('')}</w:tr>`;
    zip.addBuffer(Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph('Before table')}<w:tbl>${row(['ID','Notes','Notes'])}${row(['001','Sound &amp; Light','Other'])}</w:tbl>${paragraph('After table')}</w:body></w:document>`),'word/document.xml');
    await new Promise((resolve,reject)=>{zip.outputStream.pipe(fs.createWriteStream(file)).on('finish',resolve).on('error',reject);zip.end();});
    const {tables}=await documentCtx.parseDocument(file,'show.docx');
    assert.equal(tables.length,3);
    assert.equal(tables[0].rows[0].action,'Before table');
    assert.equal(tables[1].rows[0].id_2,'001');
    assert.equal(tables[1].rows[0].notes,'Sound & Light');
    assert.equal(tables[1].rows[0].notes_2,'Other');
    assert.equal(tables[2].rows[0].action,'After table');
    await assert.rejects(documentCtx.parseDocument(file,'show.exe'),/Unsupported file type/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

import {getDocumentProxy} from 'unpdf';
import {OPS} from 'unpdf/pdfjs';
function simplePdf(lines) {
  const content='BT /F1 12 Tf 50 750 Td '+lines.map((line,i)=>`${i ? '0 -20 Td ' : ''}(${line.replace(/[()\\]/g,'\\$&')}) Tj`).join('\n')+' ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let output='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(output);
  output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return output;
}
test('real text PDF preserves filename cues and screen labels with explicit review warnings',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lxflow-pdf-test-'));
  try {
    const file=path.join(dir,'show.pdf');fs.writeFileSync(file,simplePdf(['9:00 AM Play intro.mp4','LEFT SCREEN','Slide deck.pptx']));
    const pdfCtx=vm.createContext({fs,path,DOMParser,getDocumentProxy,OPS,Uint8Array,uid:()=>`cue_${++id}`});
    vm.runInContext(source.slice(source.indexOf('const _FILE_EXT'),source.indexOf('/* ---- client HTML'))+'\nglobalThis.parseDocument=parseUpload;',pdfCtx);
    const {tables}=await pdfCtx.parseDocument(file,'show.pdf');
    const text=JSON.stringify(tables);
    assert.match(text,/intro\.mp4/);assert.match(text,/LEFT SCREEN/);assert.match(text,/deck\.pptx/);
    assert.ok(tables[0].warnings.some(w=>w.includes('approximate')));
    fs.writeFileSync(file,simplePdf([]));
    await assert.rejects(pdfCtx.parseDocument(file,'show.pdf'),/no extractable text/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('PDF 24-hour cues and images without a preceding cue remain separate',async()=>{
  let destroyed=false;
  const page={
    getTextContent:async()=>({items:[{str:'13:05:30 Video intro.mp4',transform:[1,0,0,1,0,600],hasEOL:true},{str:'14:00 Next cue',transform:[1,0,0,1,0,500],hasEOL:true}]}),
    getOperatorList:async()=>({fnArray:[OPS.transform,OPS.paintImageXObject],argsArray:[[100,0,0,50,0,700],['image1']]})
  };
  const pdfCtx=vm.createContext({fs:{readFileSync:()=>new Uint8Array()},path,DOMParser,OPS,Uint8Array,uid:()=>`cue_${++id}`,getDocumentProxy:async()=>({numPages:1,getPage:async()=>page,destroy:async()=>{destroyed=true;}}),saveImageBuf:()=> 'img_test.png'});
  vm.runInContext(source.slice(source.indexOf('const _FILE_EXT'),source.indexOf('/* ---- client HTML'))+'\ngetPdfObj=async()=>({});imgToRGBA=()=>({width:8,height:8,rgba:[]});rgbaToPngBuf=()=>null;globalThis.parse=parsePdf;',pdfCtx);
  const [table]=await pdfCtx.parse('unused.pdf');
  assert.equal(table.rows[0].time,'13:05:30');assert.equal(table.rows[0].action,'Video intro.mp4');
  assert.equal(table.rows[1].time,'14:00');
  assert.equal(table.rows[1]._images,undefined);
  assert.match(table.rows[2].action,/Unassigned image/);
  assert.equal(table.rows[2]._images[0],'img_test.png');
  assert.equal(destroyed,true);
});
