const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build on Windows x64.');
  const root = path.resolve(__dirname, '..');
  const pkg = require(path.join(root, 'package.json'));
  const lock = require(path.join(root, 'package-lock.json'));
  const release = path.join(root, 'release'); await fs.mkdir(release, { recursive: true });
  const name = `stock-bar-${pkg.version}-win32-x64`;
  const finishing = process.argv.includes('--finish');
  const staging = finishing ? JSON.parse(await fs.readFile(path.join(release, 'latest-stage.json'), 'utf8')).staging
    : await fs.mkdtemp(path.join(release, '.build-'));
  if (path.dirname(path.resolve(staging)) !== release || !/^\.build-[a-zA-Z0-9]+$/.test(path.basename(staging))) throw Error('Invalid staging directory');
  const output = path.join(staging, name);
  const app = path.join(output, 'resources', 'app');
  if (!finishing) {
  const pythonRuntime = path.join(root, '.cache', 'akshare-runtime');
  const runtimeBuild = spawnSync(path.join(root, '.cache', 'akshare-venv', 'Scripts', 'python.exe'),
    [path.join(root, 'scripts', 'build-akshare-runtime.py'), '--output', pythonRuntime], { windowsHide: true, encoding: 'utf8' });
  if (runtimeBuild.status !== 0) throw Error(runtimeBuild.stderr || runtimeBuild.error?.message || 'Prepare AKShare with npm run setup:akshare before packaging.');
  await fs.cp(path.join(root, 'node_modules', 'electron', 'dist'), output, { recursive: true });
  await fs.rename(path.join(output, 'electron.exe'), path.join(output, 'stock-bar.exe'));
  await fs.rm(path.join(output, 'resources', 'default_app.asar'), { force: true });
  await fs.mkdir(app, { recursive: true });
  for (const directory of ['dist', 'dist-electron']) await fs.cp(path.join(root, directory), path.join(app, directory), { recursive: true });
  await fs.cp(pythonRuntime, path.join(app, 'runtime', 'python'), { recursive: true });
  await fs.mkdir(path.join(app, 'scripts'), { recursive: true });
  for (const file of ['akshare-directory.py', 'setup-akshare.ps1', 'requirements-akshare.txt', 'inspect-window.ps1']) {
    await fs.copyFile(path.join(root, 'scripts', file), path.join(app, 'scripts', file));
  }
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'stock-bar', version: pkg.version,
    description: pkg.description, main: pkg.main, dependencies: pkg.dependencies }, null, 2) + '\n');
  for (const [directory, entry] of Object.entries(lock.packages)) {
    if (!directory.startsWith('node_modules/') || entry.dev) continue;
    // Copy exact installed production dependency locations, including nested versions and licenses.
    await fs.cp(path.join(root, directory), path.join(app, directory), { recursive: true });
  }
  }
  await fs.cp(path.join(root, 'docs'), path.join(output, 'docs'), { recursive: true });
  await fs.copyFile(path.join(root, 'GLOSSARY.md'), path.join(output, 'GLOSSARY.md'));
  await fs.copyFile(path.join(root, 'docs', 'portable-guide.txt'), path.join(output, '使用说明.txt'));
  const native = path.join(app, 'dist-electron', 'native', 'fullscreen-monitor.exe');
  for (const executable of [path.join(output, 'stock-bar.exe'), native, path.join(app, 'dist-electron', 'native', 'shortcut-monitor.exe'), path.join(app, 'runtime', 'python', 'python.exe')]) {
    const data = await fs.readFile(executable);
    if (data.readUInt16LE(data.readUInt32LE(0x3c) + 4) !== 0x8664) throw Error('Executable is not Windows x64: ' + executable);
  }
  if (process.argv.includes('--stage-only')) {
    const stage = { staging, stagedApp: output, version: pkg.version };
    await fs.writeFile(path.join(release, 'latest-stage.json'), JSON.stringify(stage, null, 2));
    console.log(JSON.stringify(stage, null, 2)); return;
  }
  const zip = path.join(staging, name + '.zip');
  const command = spawnSync('powershell.exe', ['-NoProfile', '-File', path.join(__dirname, 'archive-release.ps1'), '-Source', output, '-Destination', zip],
    { windowsHide: true, encoding: 'utf8' });
  if (command.status !== 0) throw Error(command.stderr || command.stdout || 'ZIP compression failed');
  const published = path.join(release, name + '.zip');
  await fs.copyFile(zip, published);
  const bytes = await fs.readFile(published);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(published + '.sha256', `${sha256}  ${path.basename(published)}\n`);
  const manifest = { version: pkg.version, architecture: 'x64', electron: require(path.join(root, 'node_modules/electron/package.json')).version,
    zip: published, stagedApp: output, bytes: bytes.length, sha256, builtAt: new Date().toISOString() };
  await fs.writeFile(path.join(release, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
