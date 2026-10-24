import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** Claude Code OAuth tokens (`claudeAiOauth` key of the credentials file). */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
  [key: string]: unknown;
}

/** Cached account data (`oauthAccount` key of ~/.claude.json). */
export interface OAuthAccount {
  accountUuid: string;
  emailAddress: string;
  organizationUuid?: string;
  displayName?: string;
  fullName?: string;
  organizationName?: string;
  [key: string]: unknown;
}

/** Everything that makes up a login. This is what is stored per account. */
export interface LoginSnapshot {
  claudeAiOauth: OAuthTokens;
  organizationUuid?: string;
  oauthAccount?: OAuthAccount;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const useKeychain = (dir?: string) => process.platform === 'darwin' && !dir && !process.env.CLAUDE_CONFIG_DIR;

export function configDir(dir?: string): string {
  return dir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

export function credentialsPath(dir?: string): string {
  return path.join(configDir(dir), '.credentials.json');
}

export function globalConfigPath(dir?: string): string {
  const base = dir ?? process.env.CLAUDE_CONFIG_DIR;
  return base ? path.join(base, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

export function usesKeychain(): boolean {
  return useKeychain();
}

function readJson(file: string): Record<string, any> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Writes to a temp file and renames it, so a half-written JSON is never left behind. */
async function writeJsonAtomic(file: string, data: unknown, mode?: number): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.cs-${process.pid}-${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // On Windows the rename fails while another process has the file open.
      if (attempt >= 5) {
        fs.rmSync(tmp, { force: true });
        fs.writeFileSync(file, text, { encoding: 'utf8', mode });
        return;
      }
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
}

function security(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('security', args, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

export async function readCredentials(dir?: string): Promise<Record<string, any> | undefined> {
  if (useKeychain(dir)) {
    try {
      return JSON.parse(await security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']));
    } catch {
      return undefined;
    }
  }
  return readJson(credentialsPath(dir));
}

export async function writeCredentials(data: Record<string, any>, dir?: string): Promise<void> {
  if (useKeychain(dir)) {
    await security(['add-generic-password', '-U', '-a', os.userInfo().username, '-s', KEYCHAIN_SERVICE, '-w', JSON.stringify(data)]);
    return;
  }
  await writeJsonAtomic(credentialsPath(dir), data, 0o600);
}

export function readGlobalConfig(dir?: string): Record<string, any> | undefined {
  return readJson(globalConfigPath(dir));
}

/** Reads the current login (tokens + account). */
export async function readCurrentLogin(dir?: string): Promise<LoginSnapshot | undefined> {
  const creds = await readCredentials(dir);
  const tokens = creds?.claudeAiOauth as OAuthTokens | undefined;
  if (!tokens?.accessToken) {
    return undefined;
  }
  return {
    claudeAiOauth: tokens,
    organizationUuid: creds?.organizationUuid,
    oauthAccount: readGlobalConfig(dir)?.oauthAccount,
  };
}

/**
 * Applies a saved login. Only the account keys are replaced — everything else
 * (plugin MCP tokens, settings, projects) is left untouched.
 */
export async function applyLogin(snap: LoginSnapshot): Promise<void> {
  const creds = (await readCredentials()) ?? {};
  creds.claudeAiOauth = snap.claudeAiOauth;
  if (snap.organizationUuid) {
    creds.organizationUuid = snap.organizationUuid;
  } else {
    delete creds.organizationUuid;
  }
  await writeCredentials(creds);

  const configFile = globalConfigPath();
  const config = readJson(configFile);
  if (!config && fs.existsSync(configFile)) {
    throw new Error(`Could not read ${configFile}`);
  }
  const next = config ?? {};
  if (snap.oauthAccount) {
    next.oauthAccount = snap.oauthAccount;
  } else {
    delete next.oauthAccount;
  }
  await writeJsonAtomic(configFile, next);
}

/** Unique key of an account: user + organization. */
export function identityOf(snap: LoginSnapshot): string | undefined {
  const account = snap.oauthAccount;
  if (!account?.accountUuid) {
    return undefined;
  }
  return `${account.accountUuid}|${snap.organizationUuid ?? account.organizationUuid ?? ''}`;
}

/** "max" + "default_claude_max_20x" → "Max 20x". */
export function planLabel(tokens: OAuthTokens): string | undefined {
  const tier = String(tokens.rateLimitTier ?? '');
  const mult = tier.match(/(\d+x)$/)?.[1];
  const sub = String(tokens.subscriptionType ?? '');
  if (!sub) {
    return undefined;
  }
  const name = sub.charAt(0).toUpperCase() + sub.slice(1);
  return mult ? `${name} ${mult}` : name;
}
