import type { OAuthAuthDetails, RefreshParts } from "./types";
import {
  parseMultiAccountRefresh,
  formatMultiAccountRefresh,
  parseRefreshParts,
  formatRefreshParts,
} from "./auth";
import { loadAccounts, saveAccounts, type AccountStorage } from "./storage";

export interface ManagedAccount {
  index: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  isRateLimited: boolean;
  rateLimitResetTime: number;
  lastUsed: number;
  email?: string;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}

/**
 * Manages multiple OAuth accounts with automatic rotation and rate limit handling.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private currentIndex = 0;
  private currentAccountIndex = -1; // Track which account is currently in use

  constructor(auth: OAuthAuthDetails, storedAccounts?: AccountStorage | null) {
    // Try loading from custom storage first
    if (storedAccounts && storedAccounts.accounts.length > 0) {
      const activeIndex =
        typeof storedAccounts.activeIndex === "number" &&
        storedAccounts.activeIndex >= 0 &&
        storedAccounts.activeIndex < storedAccounts.accounts.length
          ? storedAccounts.activeIndex
          : 0;

      this.currentAccountIndex = activeIndex;
      this.currentIndex = activeIndex;

      // Load from custom storage (preferred - includes emails)
      this.accounts = storedAccounts.accounts.map((acc, index) => ({
        index,
        parts: {
          refreshToken: acc.refreshToken,
          projectId: acc.projectId,
          managedProjectId: acc.managedProjectId,
        },
        access: index === activeIndex ? auth.access : undefined,
        expires: index === activeIndex ? auth.expires : undefined,
        isRateLimited: acc.isRateLimited || false,
        rateLimitResetTime: acc.rateLimitResetTime || 0,
        lastUsed: acc.lastUsed,
        email: acc.email,
        lastSwitchReason: acc.lastSwitchReason,
      }));
    } else {
      // Fall back to parsing from auth.refresh (multi-account format)
      const multiAccount = parseMultiAccountRefresh(auth.refresh);

      this.currentAccountIndex = 0;
      this.currentIndex = 0;

      if (multiAccount.accounts.length > 0) {
        this.accounts = multiAccount.accounts.map((parts, index) => ({
          index,
          parts,
          access: index === 0 ? auth.access : undefined,
          expires: index === 0 ? auth.expires : undefined,
          isRateLimited: false,
          rateLimitResetTime: 0,
          lastUsed: 0,
        }));
      } else {
        // Fallback: treat as single account
        this.accounts.push({
          index: 0,
          parts: parseRefreshParts(auth.refresh),
          access: auth.access,
          expires: auth.expires,
          isRateLimited: false,
          rateLimitResetTime: 0,
          lastUsed: 0,
        });
      }
    }
  }
  
  /**
   * Save accounts to custom storage file.
   */
  async save(): Promise<void> {
    const storage: AccountStorage = {
      version: 1,
      accounts: this.accounts.map(acc => ({
        email: acc.email,
        refreshToken: acc.parts.refreshToken,
        projectId: acc.parts.projectId,
        managedProjectId: acc.parts.managedProjectId,
        addedAt: acc.lastUsed || Date.now(),
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        isRateLimited: acc.isRateLimited,
        rateLimitResetTime: acc.rateLimitResetTime,
      })),
      activeIndex: Math.max(0, this.currentAccountIndex),
    };
    
    await saveAccounts(storage);
  }
  
  /**
   * Get the currently active account.
   */
  getCurrentAccount(): ManagedAccount | null {
    if (this.currentAccountIndex >= 0 && this.currentAccountIndex < this.accounts.length) {
      return this.accounts[this.currentAccountIndex] ?? null;
    }
    return null;
  }
  
  /**
   * Mark that we've switched to a specific account.
   */
  markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation"): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndex = account.index;
  }

  /**
   * Returns the total number of accounts.
   */
  getAccountCount(): number {
    return this.accounts.length;
  }

  /**
   * Gets the current account if available, or switches to next available account.
   * Use this for sticky account selection (only switches on error).
   * Returns null if all accounts are rate-limited.
   */
  getCurrentOrNext(): ManagedAccount | null {
    // First check if we have a current account that's still usable
    const current = this.getCurrentAccount();
    if (current && !current.isRateLimited) {
      current.lastUsed = Date.now();
      return current;
    }
    
    // If current is rate-limited or doesn't exist, check if it can be un-limited
    if (current?.isRateLimited && Date.now() > current.rateLimitResetTime) {
      current.isRateLimited = false;
      current.lastUsed = Date.now();
      return current;
    }
    
    // Need to switch - get next available account and mark it as current
    const next = this.getNext();
    if (next) {
      this.currentAccountIndex = next.index;
    }
    return next;
  }

  /**
   * Gets the next available account (not rate-limited).
   * Returns null if all accounts are rate-limited.
   */
  getNext(): ManagedAccount | null {
    // Clear rate limits for accounts whose timeout has expired
    const available = this.accounts.filter(a => {
      if (!a.isRateLimited) return true;
      if (Date.now() > a.rateLimitResetTime) {
        a.isRateLimited = false;
        return true;
      }
      return false;
    });

    if (available.length === 0) {
      return null; // All accounts are rate-limited
    }

    // Round-robin selection
    const account = available[this.currentIndex % available.length];
    if (!account) {
      return null;
    }
    
    this.currentIndex++;
    account.lastUsed = Date.now();
    return account;
  }

  /**
   * Marks an account as rate-limited for the specified duration.
   */
  markRateLimited(account: ManagedAccount, retryAfterMs: number): void {
    account.isRateLimited = true;
    account.rateLimitResetTime = Date.now() + retryAfterMs;
  }

  /**
   * Updates account tokens after a successful refresh.
   */
  updateAccount(account: ManagedAccount, access: string, expires: number, parts?: RefreshParts): void {
    account.access = access;
    account.expires = expires;
    if (parts) {
      account.parts = parts;
    }
  }

  /**
   * Serializes only the current active account to OAuthAuthDetails format.
   * All accounts are stored in antigravity-accounts.json instead.
   */
  toAuthDetails(): OAuthAuthDetails {
    const current = this.getCurrentAccount() || this.accounts[0];
    if (!current) {
      throw new Error("No accounts available");
    }

    return {
      type: "oauth",
      refresh: formatMultiAccountRefresh({ accounts: this.accounts.map((acc) => acc.parts) }),
      access: current.access || "",
      expires: current.expires || 0,
    };
  }

  /**
   * Adds a new account to the pool.
   */
  addAccount(parts: RefreshParts, access?: string, expires?: number, email?: string): void {
    this.accounts.push({
      index: this.accounts.length,
      parts,
      access,
      expires,
      isRateLimited: false,
      rateLimitResetTime: 0,
      lastUsed: 0,
      email,
    });
  }

  /**
   * Removes an account by index.
   * Returns true if successful, false if index is invalid.
   */
  removeAccount(index: number): boolean {
    if (index < 0 || index >= this.accounts.length) {
      return false;
    }
    this.accounts.splice(index, 1);
    // Re-index remaining accounts
    this.accounts.forEach((acc, idx) => (acc.index = idx));
    return true;
  }

  /**
   * Returns a copy of all accounts for display/management.
   */
  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  /**
   * Converts an account back to OAuthAuthDetails for individual operations.
   */
  accountToAuth(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access ?? "",
      expires: account.expires ?? 0,
    };
  }

  /**
   * Gets the minimum wait time until any rate-limited account becomes available.
   * Returns 0 if at least one account is available.
   */
  getMinWaitTime(): number {
    const available = this.accounts.filter(a => !a.isRateLimited || Date.now() > a.rateLimitResetTime);
    if (available.length > 0) {
      return 0;
    }

    const waitTimes = this.accounts
      .filter(a => a.isRateLimited)
      .map(a => Math.max(0, a.rateLimitResetTime - Date.now()));

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }
}
