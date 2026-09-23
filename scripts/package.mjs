import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { exec } from '@yao-pkg/pkg';
import yazl from 'yazl';

// Build from an explicit file allowlist: never copy a working installation's data.
const standalone = !process.argv.includes('--launchers-only');
const bundle = await readFile('build/server.cjs');
const artifacts = [];
async function archive(name, files) {
  const zip = new yazl.ZipFile();
  await mkdir('dist', { recursive: true });
  for (const [relative, bytes, executable = false] of files) {
    const filename = `dist/${name}/${relative}`;
    await mkdir(filename.slice(0, filename.lastIndexOf('/')), { recursive: true });
    await writeFile(filename, bytes);
    if (executable) await chmod(filename, 0o755);
    zip.addBuffer(Buffer.from(bytes), `${name}/${relative}`, {
      mtime: new Date('2020-01-01T00:00:00Z'), mode: executable ? 0o100755 : 0o100644,
    });
  }
  zip.end();
  const filename = `dist/${name}.zip`;
  await pipeline(zip.outputStream, createWriteStream(filename));
  artifacts.push({ file: filename, sha256: createHash('sha256').update(await readFile(filename)).digest('hex') });
  console.log(`Created ${filename}`);
}
const instructions = (runtime) => `LXFlow\n\nExtract the entire ZIP into a writable folder, then open Start LXFlow.\n${runtime}\nKeep the terminal open during the show. Close it to stop the server.\nCoworkers connect to the address printed in the terminal.\n\nUPGRADING: Stop the old server and back up runofshow-data.json,\nrunofshow-config.json, and the entire runofshow-images folder. Copy them\nfrom your old app folder into this package's app folder before launch.\nDo not run old and new servers against the same data simultaneously.\n`;
for (const platform of ['Windows', 'Mac']) {
  const win = platform === 'Windows';
  const launcher = win
    ? '@echo off\r\ntitle LXFlow\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (echo Install Node.js 22 or newer from https://nodejs.org & pause & exit /b 1)\r\nnode "%~dp0app\\server.cjs" %*\r\npause\r\n'
    : '#!/bin/bash\ncd "$(dirname "$0")"\nif ! command -v node >/dev/null 2>&1; then\n echo "Install Node.js 22 or newer from https://nodejs.org"\n read -r -p "Press Enter to close"\n exit 1\nfi\nnode ./app/server.cjs "$@"\n';
  await archive(`LXFlow (${platform})`, [['app/server.cjs', bundle], [`Start LXFlow.${win ? 'bat' : 'command'}`, launcher, !win], ['READ ME FIRST.txt', instructions('Requires Node.js 22 or newer on the host computer.')]]);
}
if (standalone) {
  for (const [target, label, filename] of [
    ['node22-win-x64', 'Windows x64', 'LXFlow.exe'],
    ['node22-macos-x64', 'Mac Intel', 'LXFlow'],
    ['node22-macos-arm64', 'Mac Apple Silicon', 'LXFlow'],
  ]) {
    const output = `build/${target}/${filename}`;
    await mkdir(`build/${target}`, { recursive: true });
    await exec(['build/server.cjs', '--target', target, '--output', output, '--no-bytecode', '--public-packages', '*', '--public']);
    const win = target.includes('-win-');
    const launcher = win
      ? '@echo off\r\ntitle LXFlow\r\ncd /d "%~dp0"\r\n"%~dp0app\\LXFlow.exe" %*\r\npause\r\n'
      : '#!/bin/bash\ncd "$(dirname "$0")"\nif ! codesign --verify ./app/LXFlow >/dev/null 2>&1; then\n codesign --force --sign - ./app/LXFlow || { echo "Unable to sign LXFlow locally."; exit 1; }\nfi\n./app/LXFlow "$@"\n';
    await archive(`LXFlow Standalone (${label})`, [[`app/${filename}`, await readFile(output), !win], [`Start LXFlow.${win ? 'bat' : 'command'}`, launcher, !win], ['READ ME FIRST.txt', instructions('No Node.js installation required. macOS builds require validation on a Mac.\nThese binaries are not developer-signed or notarized.')]]);
  }
}
await writeFile(`dist/${standalone ? 'SHA256SUMS' : 'SHA256SUMS-launchers'}.txt`, artifacts.map(a => `${a.sha256}  ${a.file.slice(5)}`).join('\n') + '\n');
