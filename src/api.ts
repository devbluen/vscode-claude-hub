import { OAuthAccount, OAuthTokens } from './claudeFiles';
import { UsageSnapshot, parseUsage } from './usage';

const API = 'https://api.anthropic.com';
/** Public values of the Claude Code OAuth client (the same ones the CLI uses). */
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const BETA = 'oauth-2025-04-20';
const GAP_MS = 400;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The refresh token was rejected: the account must sign in again. */
    readonly invalidGrant = false,
  ) {
    super(message);
  }
}

// One request at a time, spaced out, so checking many accounts does not hit 429.
let queue: Promise<unknown> = Promise.resolve();
let backoffUntil = 0;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    if (Date.now() < backoffUntil) {
      throw new ApiError(429, 'rate_limited');
    }
    try {
      return await task();
    } finally {
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function get(pathname: string, token: string): Promise<any> {
  const res = await fetch(API + pathname, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': BETA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    backoffUntil = Date.now() + 5 * 60_000;
  }
  if (!res.ok) {
    throw new ApiError(res.status, `HTTP ${res.status}`);
  }
  return res.json();
}

/** Usage limits of the subscription (the same data as Claude Code's /usage). */
export function fetchUsage(token: string): Promise<UsageSnapshot> {
  return enqueue(async () => parseUsage(await get('/api/oauth/usage', token)));
}

/** Used when an isolated login did not write the account data. */
export function fetchProfile(token: string): Promise<OAuthAccount> {
  return enqueue(async () => {
    const data = await get('/api/oauth/profile', token);
    return {
      accountUuid: data.account?.uuid,
      emailAddress: data.account?.email,
      displayName: data.account?.display_name,
      fullName: data.account?.full_name,
      organizationUuid: data.organization?.uuid,
      organizationName: data.organization?.name,
    };
  });
}

/**
 * Gets a new access token. Refresh tokens are single-use: the caller must store the
 * returned tokens right away. Only ever used for accounts that are NOT active in
 * Claude Code — the active one is refreshed by Claude Code itself.
 */
export function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  return enqueue(async () => {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID,
    };
    const scopes = Array.isArray(tokens.scopes) ? (tokens.scopes as string[]).filter((s) => s !== 'org:create_api_key') : [];
    if (scopes.length) {
      body.scope = scopes.join(' ');
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const invalid = (res.status === 400 || res.status === 401) && /invalid_grant|invalid_token|revoked/i.test(text);
      throw new ApiError(res.status, `HTTP ${res.status}`, invalid);
    }
    const data: any = await res.json();
    if (!data.access_token) {
      throw new ApiError(0, 'no_access_token');
    }
    const now = Date.now();
    return {
      ...tokens,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: data.expires_in ? now + data.expires_in * 1000 : tokens.expiresAt,
      ...(data.refresh_token_expires_in ? { refreshTokenExpiresAt: now + data.refresh_token_expires_in * 1000 } : {}),
      ...(typeof data.scope === 'string' ? { scopes: data.scope.split(/\s+/).filter(Boolean) } : {}),
    };
  });
}
