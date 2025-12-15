import type { AuthDetails, OAuthAuthDetails, RefreshParts, MultiAccountRefreshParts } from "./types";

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
const ACCOUNT_SEPARATOR = "||";

export function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === "oauth";
}

/**
 * Splits a packed refresh string into its constituent refresh token and project IDs.
 */
export function parseRefreshParts(refresh: string): RefreshParts {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
  };
}

/**
 * Serializes refresh token parts into the stored string format.
 */
export function formatRefreshParts(parts: RefreshParts): string {
  const projectSegment = parts.projectId ?? "";
  const base = `${parts.refreshToken}|${projectSegment}`;
  return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

/**
 * Determines whether an access token is expired or missing, with buffer for clock skew.
 */
export function accessTokenExpired(auth: OAuthAuthDetails): boolean {
  if (!auth.access || typeof auth.expires !== "number") {
    return true;
  }
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Parses refresh string that may contain multiple accounts separated by ||
 */
export function parseMultiAccountRefresh(refresh: string): MultiAccountRefreshParts {
  if (!refresh) {
    return { accounts: [] };
  }

  const accountStrings = refresh.split(ACCOUNT_SEPARATOR).filter(s => s.trim());
  
  if (accountStrings.length === 0) {
    return { accounts: [] };
  }

  return {
    accounts: accountStrings.map(parseRefreshParts)
  };
}

/**
 * Serializes multiple accounts into refresh string
 */
export function formatMultiAccountRefresh(parts: MultiAccountRefreshParts): string {
  return parts.accounts
    .map(formatRefreshParts)
    .filter(s => s.trim())
    .join(ACCOUNT_SEPARATOR);
}
