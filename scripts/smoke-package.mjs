import { mkdtemp, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import net from 'node:net';
import XLSX from 'xlsx';

for (const [target, cpu] of [['node22-macos-x64', 0x01000007], ['node22-macos-arm64', 0x0100000c]]) {
  const bytes = await readFile(`build/${target}/LXFlow`);
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, `${target} Mach-O header`);
  assert.equal(bytes.readUInt32LE(4), cpu, `${target} CPU type`);
}
if (process.platform !== 'win32') throw new Error('Windows runtime smoke test must run on Windows');
const runtime = await mkdtemp(path.join(tmpdir(), 'lxflow-smoke-'));
const exe = path.join(runtime, 'LXFlow.exe');
await copyFile('build/node22-win-x64/LXFlow.exe', exe);
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn(exe, [`--port=${port}`, '--host=127.0.0.1', '--no-open'], { cwd: runtime, windowsHide: true, env: { ...process.env, ROS_HOST: '127.0.0.1', ROS_NO_OPEN: '1', ROS_DATA: path.join(runtime, 'runofshow-data.json') } });
let output = '';
child.stdout.on('data', b => { output += b; });
child.stderr.on('data', b => { output += b; });
try {
  let html;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Executable exited: ${output}`);
    try { html = await (await fetch(`http://127.0.0.1:${port}/`)).text(); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(html || '', /LXFlow/);
  const wb=XLSX.utils.book_new();
  const sheet=XLSX.utils.aoa_to_sheet([['Personnel'],[],['Time','Duration'],[6.5/24,25/24]]);
  sheet.A4.z='h:mm:ss AM/PM'; sheet.B4.z='[h]:mm:ss';
  XLSX.utils.book_append_sheet(wb,sheet,'Show');
  const sheetForm=new FormData();
  sheetForm.append('file',new Blob([XLSX.write(wb,{type:'buffer',bookType:'xlsx'})]),'show.xlsx');
  sheetForm.append('startRow','3');
  const sheetImport=await (await fetch(`http://127.0.0.1:${port}/upload`,{method:'POST',body:sheetForm})).json();
  assert.equal(sheetImport.ok,true);
  assert.equal(sheetImport.tables[0].rows.length,1);
  assert.equal(sheetImport.tables[0].rows[0].time,'6:30:00 AM');
  assert.equal(sheetImport.tables[0].rows[0].duration,'25:00:00');
  console.log('PASS standalone spreadsheet upload preserves time/duration and physical starting row.');
  // Tiny PDF with text and a raw RGB image exercises PDF.js and PNG extraction.
  const stream = 'BT /F1 12 Tf 20 150 Td (Packaging cue check) Tj ET q 20 0 0 20 20 50 cm /Im1 Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 768 >>\nstream\n${'abc'.repeat(256)}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 7 >>\nstartxref\n${xref}\n%%EOF`;
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'packaging.pdf');
  const imported = await (await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: form })).json();
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.match(JSON.stringify(imported.tables), /Packaging cue check/);
  const imageId = imported.tables[0].rows[0]._images?.[0];
  assert.ok(imageId, 'Embedded PDF image attached to cue');
  const png = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/img/${imageId}`)).arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  console.log('PASS Windows standalone serves LXFlow on loopback; both Mac executable headers/architectures valid.');
  console.log('PASS bundled PDF text import with an embedded image.');
  console.log(`Isolated runtime: ${runtime}`);
} finally { child.kill(); }
