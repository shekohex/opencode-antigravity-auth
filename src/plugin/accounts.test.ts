import { describe, it, expect } from "bun:test";
import { AccountManager } from "./accounts";
import type { OAuthAuthDetails } from "./types";

describe("AccountManager", () => {
  it("should initialize with single account", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_token_1|project_1",
      access: "access_token_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    expect(manager.getAccountCount()).toBe(1);
  });

  it("should parse multi-account refresh string", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    expect(manager.getAccountCount()).toBe(2);
  });

  it("should return current account when not rate-limited", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const account = manager.getCurrentOrNext();
    
    expect(account).not.toBeNull();
    expect(account?.index).toBe(0);
  });

  it("should switch to next account when current is rate-limited", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const firstAccount = manager.getCurrentOrNext();
    
    // Rate-limit first account
    manager.markRateLimited(firstAccount!, 60000);
    
    // Should switch to second account
    const secondAccount = manager.getCurrentOrNext();
    expect(secondAccount?.index).toBe(1);
  });

  it("should return null when all accounts are rate-limited", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    
    // Rate-limit all accounts
    const accounts = manager.getAccounts();
    accounts.forEach(acc => manager.markRateLimited(acc, 60000));
    
    const next = manager.getCurrentOrNext();
    expect(next).toBeNull();
  });

  it("should un-rate-limit accounts after timeout expires", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const account = manager.getCurrentOrNext();
    
    // Rate-limit with past timeout (already expired)
    account!.isRateLimited = true;
    account!.rateLimitResetTime = Date.now() - 1000; // 1 second ago
    
    // Should be available again
    const next = manager.getCurrentOrNext();
    expect(next).not.toBeNull();
    expect(next?.isRateLimited).toBe(false);
  });

  it("should calculate minimum wait time correctly", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const accounts = manager.getAccounts();
    
    // Rate-limit first account for 30s, second for 60s
    manager.markRateLimited(accounts[0]!, 30000);
    manager.markRateLimited(accounts[1]!, 60000);
    
    const waitTime = manager.getMinWaitTime();
    // Should return the minimum (30s), allowing some tolerance for execution time
    expect(waitTime).toBeGreaterThanOrEqual(29000);
    expect(waitTime).toBeLessThanOrEqual(30000);
  });

  it("should track account usage", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    
    const beforeTime = Date.now();
    const account = manager.getCurrentOrNext();
    const afterTime = Date.now();
    
    expect(account?.lastUsed).toBeGreaterThanOrEqual(beforeTime);
    expect(account?.lastUsed).toBeLessThanOrEqual(afterTime);
  });
});
