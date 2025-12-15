import type { PluginContext, GetAuth, ProjectContextResult } from "./types";
import { CODE_ASSIST_ENDPOINT_FALLBACKS, ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { isOAuthAuth, accessTokenExpired, parseRefreshParts } from "./auth";
import { AccountManager } from "./accounts";
import { loadAccounts } from "./storage";
import { refreshAccessToken } from "./token";
import { ensureProjectContext } from "./project";
import { isGenerativeLanguageRequest, prepareAntigravityRequest, transformAntigravityResponse } from "./request";
import { getSessionId } from "./request-helpers";
import { startAntigravityDebugRequest } from "./debug";
import { createLogger } from "./logger";

const log = createLogger("fetch-wrapper");

function toUrlStr(value: RequestInfo | URL): string {
  if (value instanceof URL) {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  return (value as Request).url ?? value.toString();
}

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function sleepWithBackoff(totalMs: number, signal?: AbortSignal | null): Promise<void> {
  const stepsMs = [3000, 5000, 10000, 20000, 30000];
  let remainingMs = Math.max(0, totalMs);
  let stepIndex = 0;

  while (remainingMs > 0) {
    const stepMs = stepsMs[stepIndex] ?? stepsMs[stepsMs.length - 1] ?? 30000;
    const waitMs = Math.min(remainingMs, stepMs);
    await sleep(waitMs, signal);
    remainingMs -= waitMs;
    stepIndex++;
  }
}

export function overrideEndpointForRequest(request: RequestInfo | URL, endpoint: string): RequestInfo | URL {
  const replaceBase = (url: string) => url.replace(/^https:\/\/[^\/]+/, endpoint);

  if (typeof request === "string") {
    return replaceBase(request);
  }

  if (request instanceof URL) {
    return replaceBase(request.toString());
  }

  if (request instanceof Request) {
    const newUrl = replaceBase(request.url);
    if (newUrl === request.url) {
      return request;
    }
    return new Request(newUrl, request);
  }

  return request;
}

function parseRetryAfterMs(response: Response): number {
  const retryAfterMsHeader = response.headers.get("retry-after-ms");
  const retryAfterSecondsHeader = response.headers.get("retry-after");
  let retryAfterMs = 60000;

  if (retryAfterMsHeader) {
    const parsed = parseInt(retryAfterMsHeader, 10);
    if (!Number.isNaN(parsed)) {
      retryAfterMs = parsed;
    }
  } else if (retryAfterSecondsHeader) {
    const parsed = parseInt(retryAfterSecondsHeader, 10);
    if (!Number.isNaN(parsed)) {
      retryAfterMs = parsed * 1000;
    }
  }

  return retryAfterMs;
}

interface AttemptInfo {
  resolvedUrl: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  streaming: boolean;
  requestedModel?: string;
}

interface EndpointLoopResult {
  type: "success" | "rate-limit" | "retry-soon" | "all-failed";
  response?: Response;
  error?: Error;
  retryAfterMs?: number;
  attemptInfo?: AttemptInfo;
}

async function handleRateLimit(
  response: Response,
  account: ReturnType<AccountManager["getCurrentOrNext"]> & {},
  accountManager: AccountManager,
  accountCount: number,
  streaming: boolean,
  client: PluginContext["client"],
  debugContext: ReturnType<typeof startAntigravityDebugRequest>,
  requestedModel: string | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<EndpointLoopResult> {
  const retryAfterMs = parseRetryAfterMs(response);

  if (accountCount === 1) {
    try {
      await transformAntigravityResponse(response, streaming, client, debugContext, requestedModel, getSessionId());
    } catch {}

    accountManager.markRateLimited(account, retryAfterMs);

    log.info(`Account ${account.index + 1}/${accountCount} rate-limited`, {
      fromAccountIndex: account.index,
      fromAccountEmail: account.email,
      accountCount,
      retryAfterMs,
      reason: "rate-limit",
    });

    try {
      await accountManager.save();
    } catch (error) {
      log.warn("Failed to save rate limit state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { type: "rate-limit", retryAfterMs };
  }

  const switchThresholdMs = 5000;

  if (retryAfterMs <= switchThresholdMs) {
    log.info("Rate-limited briefly; retrying same account", {
      accountIndex: account.index,
      accountEmail: account.email,
      accountCount,
      retryAfterMs,
      switchThresholdMs,
    });

    try {
      await client.tui.showToast({
        body: {
          message: `Rate limited briefly. Retrying in ${Math.ceil(retryAfterMs / 1000)}s...`,
          variant: "warning",
        },
      });
    } catch {}

    await sleepWithBackoff(retryAfterMs, abortSignal);
    return { type: "retry-soon" };
  }

  accountManager.markRateLimited(account, retryAfterMs);

  log.info(`Account ${account.index + 1}/${accountCount} rate-limited, switching...`, {
    fromAccountIndex: account.index,
    fromAccountEmail: account.email,
    accountCount,
    retryAfterMs,
    reason: "rate-limit",
  });

  try {
    await client.tui.showToast({
      body: {
        message: `Rate limited on ${account.email || `Account ${account.index + 1}`}. Switching...`,
        variant: "warning",
      },
    });
  } catch {}

  try {
    await accountManager.save();
  } catch (error) {
    log.warn("Failed to save rate limit state", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { type: "rate-limit", retryAfterMs };
}

async function handleServerError(
  response: Response,
  account: ReturnType<AccountManager["getCurrentOrNext"]> & {},
  accountManager: AccountManager,
  accountCount: number,
  client: PluginContext["client"],
): Promise<EndpointLoopResult> {
  const retryAfterMs = 60000;

  accountManager.markRateLimited(account, retryAfterMs);

  log.warn(`Account ${account.index + 1}/${accountCount} received ${response.status} error on all endpoints`, {
    fromAccountIndex: account.index,
    fromAccountEmail: account.email,
    accountCount,
    status: response.status,
    retryAfterMs,
    reason: "server-error",
  });

  if (accountCount > 1) {
    await client.tui.showToast({
      body: {
        message: `Server error on ${account.email || `Account ${account.index + 1}`}. Switching...`,
        variant: "warning",
      },
    });
  }

  try {
    await accountManager.save();
  } catch (error) {
    log.warn("Failed to save rate limit state", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { type: "rate-limit", retryAfterMs };
}

async function tryEndpointFallbacks(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  projectContext: ProjectContextResult,
  account: ReturnType<AccountManager["getCurrentOrNext"]> & {},
  accountManager: AccountManager,
  accountCount: number,
  client: PluginContext["client"],
  abortSignal: AbortSignal | undefined,
): Promise<EndpointLoopResult> {
  let lastError: Error | null = null;
  let lastResponse: Response | null = null;
  let lastAttemptInfo: AttemptInfo | null = null;

  const normalizedInput: RequestInfo = input instanceof URL ? input.toString() : input;

  for (let i = 0; i < CODE_ASSIST_ENDPOINT_FALLBACKS.length; i++) {
    const currentEndpoint = CODE_ASSIST_ENDPOINT_FALLBACKS[i];
    if (!currentEndpoint) continue;

    try {
      const { request, init: transformedInit, streaming, requestedModel } = await prepareAntigravityRequest(
        normalizedInput,
        init,
        accessToken,
        projectContext.effectiveProjectId,
      );

      const finalUrl = overrideEndpointForRequest(request, currentEndpoint);

      const originalUrl = toUrlStr(input);
      const resolvedUrl = toUrlStr(finalUrl);
      lastAttemptInfo = {
        resolvedUrl,
        method: transformedInit.method,
        headers: transformedInit.headers,
        body: transformedInit.body,
        streaming,
        requestedModel,
      };

      const debugContext = startAntigravityDebugRequest({
        originalUrl,
        resolvedUrl,
        method: transformedInit.method,
        headers: transformedInit.headers,
        body: transformedInit.body,
        streaming,
        projectId: projectContext.effectiveProjectId,
        sessionId: getSessionId(),
      });

      const response = await fetch(finalUrl, transformedInit);

      if (response.status === 429) {
        return handleRateLimit(
          response,
          account,
          accountManager,
          accountCount,
          streaming,
          client,
          debugContext,
          requestedModel,
          abortSignal,
        );
      }

      if (response.status >= 500 && i === CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
        return handleServerError(response, account, accountManager, accountCount, client);
      }

      const shouldRetryEndpoint = response.status === 403 || response.status === 404 || response.status >= 500;

      if (shouldRetryEndpoint && i < CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
        lastResponse = response;
        continue;
      }

      return { type: "success", response, attemptInfo: lastAttemptInfo };
    } catch (error) {
      if (i < CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      throw error;
    }
  }

  if (lastResponse) {
    return { type: "all-failed", response: lastResponse, attemptInfo: lastAttemptInfo ?? undefined };
  }

  return { type: "all-failed", error: lastError ?? new Error("All endpoints failed") };
}

export function createAntigravityFetch(
  getAuth: GetAuth,
  client: PluginContext["client"],
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const normalizedInput: RequestInfo = input instanceof URL ? input.toString() : input;

    if (!isGenerativeLanguageRequest(normalizedInput)) {
      return fetch(input, init);
    }

    const latestAuth = await getAuth();
    if (!isOAuthAuth(latestAuth)) {
      return fetch(input, init);
    }

    const storedAccounts = await loadAccounts();
    const accountManager = new AccountManager(latestAuth, storedAccounts);
    const accountCount = accountManager.getAccountCount();

    const resolveProjectContext = async (authRecord: typeof latestAuth): Promise<ProjectContextResult> => {
      return ensureProjectContext(authRecord, client);
    };

    const abortSignal = init?.signal ?? undefined;

    while (true) {
      const previousAccount = accountManager.getCurrentAccount();
      const account = accountManager.getCurrentOrNext();

      if (!account) {
        const waitTimeMs = accountManager.getMinWaitTime() || 60000;
        const waitTimeSec = Math.ceil(waitTimeMs / 1000);

        log.info(`All ${accountCount} account(s) are rate-limited, waiting...`, { accountCount, waitTimeSec });

        try {
          await client.tui.showToast({
            body: {
              message: `Antigravity Rate Limited. Retrying after ${waitTimeSec}s...`,
              variant: "warning",
            },
          });
        } catch {}

        await sleepWithBackoff(waitTimeMs, abortSignal);
        continue;
      }

      const isSwitch = !previousAccount || previousAccount.index !== account.index;

      if (isSwitch) {
        const switchReason = previousAccount ? (previousAccount.isRateLimited ? "rate-limit" : "rotation") : "initial";
        accountManager.markSwitched(account, switchReason);

        log.info(
          `Using account ${account.index + 1}/${accountCount}${account.email ? ` (${account.email})` : ""}`,
          {
            accountIndex: account.index,
            accountEmail: account.email,
            accountCount,
            reason: switchReason,
          },
        );

        try {
          await accountManager.save();
        } catch (error) {
          log.warn("Failed to save account switch state", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let authRecord = accountManager.accountToAuth(account);

      if (accessTokenExpired(authRecord)) {
        const refreshed = await refreshAccessToken(authRecord, client);
        if (!refreshed) continue;
        authRecord = refreshed;
        const parts = parseRefreshParts(refreshed.refresh);
        accountManager.updateAccount(account, refreshed.access!, refreshed.expires!, parts);

        try {
          await accountManager.save();
        } catch (error) {
          log.warn("Failed to save account state after token refresh", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const accessToken = authRecord.access;
      if (!accessToken) continue;

      const projectContext = await resolveProjectContext(authRecord);

      const result = await tryEndpointFallbacks(
        input,
        init,
        accessToken,
        projectContext,
        account,
        accountManager,
        accountCount,
        client,
        abortSignal,
      );

      if (result.type === "retry-soon") {
        continue;
      }

      if (result.type === "rate-limit") {
        if (accountCount === 1) {
          const waitMs = result.retryAfterMs || accountManager.getMinWaitTime() || 60000;
          log.info("Single account rate-limited, retrying after backoff", { waitMs, waitSec: Math.ceil(waitMs / 1000) });
          await sleepWithBackoff(waitMs, abortSignal);
        }
        continue;
      }

      if (result.type === "success" && result.response) {
        try {
          await client.auth.set({
            path: { id: ANTIGRAVITY_PROVIDER_ID },
            body: accountManager.toAuthDetails(),
          });
          await accountManager.save();
        } catch (saveError) {
          log.error("Failed to save updated auth", {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          });
          await client.tui.showToast({
            body: { message: "Failed to save updated auth", variant: "error" },
          });
        }

        const { streaming, requestedModel } = result.attemptInfo ?? { streaming: false, requestedModel: undefined };
        const debugContext = startAntigravityDebugRequest({
          originalUrl: toUrlStr(input),
          resolvedUrl: result.attemptInfo?.resolvedUrl ?? toUrlStr(input),
          method: result.attemptInfo?.method,
          headers: result.attemptInfo?.headers,
          body: result.attemptInfo?.body,
          streaming,
          projectId: projectContext.effectiveProjectId,
          sessionId: getSessionId(),
        });

        return transformAntigravityResponse(result.response, streaming, client, debugContext, requestedModel, getSessionId());
      }

      if (result.type === "all-failed") {
        if (result.response && result.attemptInfo) {
          const debugContext = startAntigravityDebugRequest({
            originalUrl: toUrlStr(input),
            resolvedUrl: result.attemptInfo.resolvedUrl,
            method: result.attemptInfo.method,
            headers: result.attemptInfo.headers,
            body: result.attemptInfo.body,
            streaming: result.attemptInfo.streaming,
            projectId: projectContext.effectiveProjectId,
            sessionId: getSessionId(),
          });

          return transformAntigravityResponse(
            result.response,
            result.attemptInfo.streaming,
            client,
            debugContext,
            result.attemptInfo.requestedModel,
            getSessionId(),
          );
        }

        throw result.error || new Error("All Antigravity endpoints failed");
      }
    }
  };
}
