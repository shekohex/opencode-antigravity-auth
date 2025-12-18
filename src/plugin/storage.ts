import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger";

const log = createLogger("storage");

export type ModelFamily = "claude" | "gemini-flash" | "gemini-pro";
export type AccountTier = "free" | "paid";

export interface RateLimitState {
  claude?: number;
  "gemini-flash"?: number;
  "gemini-pro"?: number;
}

export interface AccountMetadataV1 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  isRateLimited?: boolean;
  rateLimitResetTime?: number;
}

export interface AccountStorageV1 {
  version: 1;
  accounts: AccountMetadataV1[];
  activeIndex: number;
}

export interface AccountMetadata {
  email?: string;
  tier?: AccountTier;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitState;
}

export interface AccountStorage {
  version: 2;
  accounts: AccountMetadata[];
  activeIndex: number;
}

type AnyAccountStorage = AccountStorageV1 | AccountStorage;

function getDataDir(): string {
  const platform = process.platform;

  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }

  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdgData, "opencode");
}

export function getStoragePath(): string {
  return join(getDataDir(), "antigravity-accounts.json");
}

function migrateV1ToV2(v1: AccountStorageV1): AccountStorage {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitState = {};
      if (acc.isRateLimited && acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime;
        rateLimitResetTimes["gemini-flash"] = acc.rateLimitResetTime;
        rateLimitResetTimes["gemini-pro"] = acc.rateLimitResetTime;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
      };
    }),
    activeIndex: v1.activeIndex,
  };
}

export async function loadAccounts(): Promise<AccountStorage | null> {
  try {
    const path = getStoragePath();
    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AnyAccountStorage;

    if (!Array.isArray(data.accounts)) {
      log.warn("Invalid storage format, ignoring");
      return null;
    }

    let storage: AccountStorage;

    if (data.version === 1) {
      log.info("Migrating account storage from v1 to v2");
      storage = migrateV1ToV2(data);
      await saveAccounts(storage);
    } else if (data.version === 2) {
      storage = data;
    } else {
      log.warn("Unknown storage version, ignoring", { version: (data as { version?: unknown }).version });
      return null;
    }

    if (typeof storage.activeIndex !== "number" || !Number.isInteger(storage.activeIndex)) {
      storage.activeIndex = 0;
    }

    if (storage.activeIndex < 0 || storage.activeIndex >= storage.accounts.length) {
      storage.activeIndex = 0;
    }

    return storage;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    log.error("Failed to load account storage", { error: String(error) });
    return null;
  }
}

export async function saveAccounts(storage: AccountStorage): Promise<void> {
  try {
    const path = getStoragePath();

    await fs.mkdir(dirname(path), { recursive: true });

    const content = JSON.stringify(storage, null, 2);
    await fs.writeFile(path, content, "utf-8");
  } catch (error) {
    log.error("Failed to save account storage", { error: String(error) });
    throw error;
  }
}

export function migrateFromRefreshString(
  accountsData: Array<{ refreshToken: string; projectId?: string; managedProjectId?: string }>,
  emails?: Array<string | undefined>,
): AccountStorage {
  const now = Date.now();

  return {
    version: 2,
    accounts: accountsData.map((acc, index) => ({
      email: emails?.[index],
      refreshToken: acc.refreshToken,
      projectId: acc.projectId,
      managedProjectId: acc.managedProjectId,
      addedAt: now,
      lastUsed: index === 0 ? now : 0,
    })),
    activeIndex: 0,
  };
}
