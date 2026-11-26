/*
 * Windows build with a reliable app icon.
 *
 * electron-builder's signAndEditExecutable step (which stamps the icon into
 * the exe) needs symlink privileges that some Windows accounts don't have.
 * So we build unpacked first, stamp the icon with rcedit (no symlinks needed),
 * then package the NSIS installer from the stamped directory.
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const ICO = path.join(ROOT, 'assets', 'icon', 'icon.ico');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const EXE = path.join(UNPACKED, 'LabelGuestXTC.exe');

function run(cmd, args) {
  console.log('+ ' + cmd + ' ' + args.join(' '));
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('Command failed: ' + cmd + ' ' + args.join(' '));
}

// 1) Build unpacked directory.
run(npx, ['electron-builder', '--win', '--x64', '--dir', '--publish', 'never']);

// 2) Stamp the icon into the exe using rcedit.
// Prefer the npm dependency (present on both CI and local after npm install);
// fall back to electron-builder's cache if available.
let rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
if (!fs.existsSync(rcedit)) {
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  if (fs.existsSync(cacheRoot)) {
    for (const d of fs.readdirSync(cacheRoot)) {
      const p = path.join(cacheRoot, d, 'rcedit-x64.exe');
      if (fs.existsSync(p)) { rcedit = p; break; }
    }
  }
}
if (!fs.existsSync(rcedit)) throw new Error('rcedit-x64.exe not found (npm rcedit dependency missing)');
if (!fs.existsSync(EXE)) throw new Error('Unpacked exe not found: ' + EXE);
console.log('+ rcedit ' + EXE + ' --set-icon ' + ICO);
execFileSync(rcedit, [EXE, '--set-icon', ICO], { stdio: 'inherit' });

// 3) Build NSIS installer from the stamped directory.
run(npx, ['electron-builder', '--win', '--x64', '--prepackaged', UNPACKED, '--publish', 'never']);
console.log('Windows build with custom icon complete.');
