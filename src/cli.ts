import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, execFile } from 'child_process';

export type CliSource = 'setting' | 'path' | 'installer' | 'npm' | 'extension';

export interface CliInfo {
  path: string;
  source: CliSource;
  version?: string;
}

const isWin = process.platform === 'win32';
const home = os.homedir();

// Full paths, so they work even when the PATH itself is broken.
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const fullPathOr = (file: string, fallback: string) => (fs.existsSync(file) ? file : fallback);
export const POWERSHELL = isWin
  ? fullPathOr(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'powershell.exe')
  : 'pwsh';
const WHERE = isWin ? fullPathOr(path.join(system32, 'where.exe'), 'where') : 'which';

/** Batch files cannot be started directly; they need the shell. */
export const needsShell = (file: string) => /\.(cmd|bat)$/i.test(file);

function run(file: string, args: string[], timeout = 10_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const done = (err: unknown, stdout: string) => resolve(err ? undefined : String(stdout).trim());
    if (needsShell(file)) {
      exec(`"${file}" ${args.join(' ')}`, { timeout, windowsHide: true }, done);
    } else {
      execFile(file, args, { timeout, windowsHide: true }, done);
    }
  });
}

/**
 * Looks the command up in a fresh PATH. The PATH of the VS Code process is the one it
 * was started with, so on Windows it also reads the current user/machine PATH from the
 * registry — a CLI installed after VS Code started is still found.
 */
async function onPath(): Promise<string[]> {
  const found = new Set<string>();
  const whereOut = await run(WHERE, isWin ? ['claude'] : ['-a', 'claude']);
  whereOut?.split(/\r?\n/).forEach((l) => l.trim() && found.add(l.trim()));
  if (isWin) {
    const fresh = await run(POWERSHELL, [
      '-NoProfile',
      '-Command',
      "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')",
    ]);
    for (const dir of (fresh ?? '').split(';').filter(Boolean)) {
      for (const name of ['claude.exe', 'claude.cmd']) {
        const p = path.join(dir.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? ''), name);
        if (fs.existsSync(p)) found.add(p);
      }
    }
  }
  return [...found];
}

function knownLocations(): Array<{ path: string; source: CliSource }> {
  const exe = isWin ? 'claude.exe' : 'claude';
  const list: Array<{ path: string; source: CliSource }> = [
    { path: path.join(home, '.local', 'bin', exe), source: 'installer' },
    { path: path.join(home, '.claude', 'local', isWin ? 'claude.exe' : 'claude'), source: 'installer' },
  ];
  if (isWin) {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    list.push({ path: path.join(appData, 'npm', 'claude.cmd'), source: 'npm' });
  } else {
    list.push(
      { path: '/opt/homebrew/bin/claude', source: 'installer' },
      { path: '/usr/local/bin/claude', source: 'installer' },
      { path: path.join(home, '.npm-global', 'bin', 'claude'), source: 'npm' },
    );
  }

  // The Claude Code extension ships its own binary.
  const extDirs = new Set<string>();
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) extDirs.add(ext.extensionPath);
  for (const base of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss']) {
    const dir = path.join(home, base, 'extensions');
    try {
      fs.readdirSync(dir)
        .filter((d) => d.startsWith('anthropic.claude-code-'))
        .sort()
        .reverse()
        .forEach((d) => extDirs.add(path.join(dir, d)));
    } catch {
      // not installed
    }
  }
  for (const dir of extDirs) {
    list.push({ path: path.join(dir, 'resources', 'native-binary', exe), source: 'extension' });
  }
  return list;
}

/** Every `claude` executable that can be found, best first. */
export async function findAllCli(): Promise<CliInfo[]> {
  const out: CliInfo[] = [];
  const seen = new Set<string>();
  const push = (p: string, source: CliSource) => {
    const key = isWin ? p.toLowerCase() : p;
    if (!seen.has(key) && fs.existsSync(p)) {
      seen.add(key);
      out.push({ path: p, source });
    }
  };
  const configured = vscode.workspace.getConfiguration('claudeSwitch').get<string>('cliPath', '').trim();
  if (configured) push(configured, 'setting');
  (await onPath()).forEach((p) => push(p, 'path'));
  knownLocations().forEach((l) => push(l.path, l.source));
  return out;
}

/** The executable to use, verified with `--version`. */
export async function findCli(): Promise<CliInfo | undefined> {
  for (const info of await findAllCli()) {
    const version = await run(info.path, ['--version']);
    if (version) {
      return { ...info, version };
    }
  }
  return undefined;
}

export async function cliVersion(file: string): Promise<string | undefined> {
  return run(file, ['--version']);
}

/** Is this directory on the user's PATH (fresh value, not the one VS Code started with)? */
export async function isDirOnPath(dir: string): Promise<boolean> {
  const norm = (d: string) => path.resolve(d).replace(/[\\/]+$/, '').toLowerCase();
  let entries = (process.env.PATH ?? '').split(path.delimiter);
  if (isWin) {
    const user = await run(POWERSHELL, ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"]);
    entries = entries.concat((user ?? '').split(';'));
  }
  return entries.filter(Boolean).some((e) => norm(e) === norm(dir));
}

/** Adds a folder to the user's PATH (Windows only). The folder is passed as an env var, never inlined. */
export function addDirToUserPath(dir: string): Promise<void> {
  const script =
    "$d=$env:CS_DIR; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; " +
    "if(($p -split ';') -notcontains $d){ [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User') }";
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-Command', script],
      { env: { ...process.env, CS_DIR: dir }, windowsHide: true, timeout: 20_000 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/** Official install command of the Claude Code CLI for this platform. */
export function installCommand(): string {
  return isWin ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
}
