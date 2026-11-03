// Builds what people download: dist\Lamhaat-Setup-<version>.exe (and the same app as a .zip).
// Inside: this PC's Node, the app, the site it publishes and only the packages it runs with, so nothing has
// to be installed first. The setup puts it in %LOCALAPPDATA%\Programs\Lamhaat (no admin needed), adds the
// Desktop and Start menu shortcuts and opens it; the app then offers what is still missing (Git, the AI
// server, its model) with their sizes. Windows' own IExpress makes the .exe.
// usage: node scripts/package.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.join(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist'), app = path.join(dist, 'Lamhaat');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
const copy = (from, to = from, filter) => fs.cpSync(path.join(root, from), path.join(app, to), { recursive: true, filter });

copy('desktop', 'desktop', f => !/[\\/](test-|fake-)[^\\/]*$/.test(f));
copy('site');
copy('scripts/keys.js');
for (const f of ['package.json', 'README.md', 'LICENSE']) if (fs.existsSync(path.join(root, f))) copy(f);
// the packages the app runs with (not the ones for building)
const deps = execFileSync('npm', ['ls', '--omit=dev', '--parseable', '--all'], { cwd: root, encoding: 'utf8', shell: true }).trim().split(/\r?\n/).slice(1);
for (const d of deps) copy(path.relative(root, d));
fs.mkdirSync(path.join(app, 'node'));
fs.copyFileSync(process.execPath, path.join(app, 'node', 'node.exe'));

// setup: close a running Lamhaat (it saves as it goes), put the new one in place, shortcuts, open it
// IExpress can't take paths with spaces: it builds in a temporary folder
const setup = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-setup-'));
fs.writeFileSync(path.join(setup, 'setup.cmd'), `@echo off
set "TO=%LOCALAPPDATA%\\Programs\\Lamhaat"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Zip "%~dp0Lamhaat.zip" -To "%TO%"
if errorlevel 1 exit /b 1
"%TO%\\node\\node.exe" --no-warnings "%TO%\\desktop\\install-shortcut.js" >nul
start "" wscript.exe "%TO%\\desktop\\Lamhaat.vbs"
`);
fs.writeFileSync(path.join(setup, 'setup.ps1'), `param($Zip, $To)
$session = Join-Path $env:USERPROFILE 'Lamhaat\\session.json'
if (Test-Path $session) {
  try {
    $s = Get-Content $session -Raw | ConvertFrom-Json
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$($s.port)/api/quit" -Headers @{ Cookie = "k=$($s.key)" } -TimeoutSec 5 | Out-Null
    Start-Sleep -Seconds 2
  } catch {}
}
try {
  foreach ($d in 'desktop', 'site', 'scripts', 'node_modules') { $p = Join-Path $To $d; if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction Stop } } # no stale files from the last version
  Expand-Archive -LiteralPath $Zip -DestinationPath $To -Force -ErrorAction Stop
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Lamhaat couldn't be installed: $($_.Exception.Message)\`n\`nClose Lamhaat if it is open, then run the setup again.", 'Lamhaat') | Out-Null
  exit 1
}
`);
const zip = path.join(dist, `Lamhaat-${version}-win-x64.zip`);
execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', app, '.']);
fs.copyFileSync(zip, path.join(setup, 'Lamhaat.zip'));

const exe = path.join(setup, `Lamhaat-Setup-${version}.exe`), files = ['setup.cmd', 'setup.ps1', 'Lamhaat.zip'];
const sed = path.join(setup, 'setup.sed');
fs.writeFileSync(sed, `[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=${exe}
FriendlyName=Lamhaat
AppLaunched=cmd /c setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
${files.map((f, i) => `FILE${i}="${f}"`).join('\n')}
[SourceFiles]
SourceFiles0=${setup}\\
[SourceFiles0]
${files.map((f, i) => `%FILE${i}%=`).join('\n')}
`);
try { execFileSync(path.join(process.env.SystemRoot, 'System32', 'iexpress.exe'), ['/N', '/Q', sed]); } catch {} // its exit code means nothing: the file tells
if (!fs.existsSync(exe)) throw new Error('IExpress made no setup file');
const out = path.join(dist, path.basename(exe));
fs.copyFileSync(exe, out);
fs.rmSync(setup, { recursive: true, force: true });
for (const f of [out, zip]) console.log(`${path.basename(f)}  ${(fs.statSync(f).size / 1e6).toFixed(0)} MB`);
