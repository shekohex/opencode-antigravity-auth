import { exec } from "node:child_process";
import { tool } from "@opencode-ai/plugin";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth";
import {
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_REDIRECT_URI,
  CODE_ASSIST_ENDPOINT_FALLBACKS,
} from "./constants";
import { accessTokenExpired, isOAuthAuth, parseRefreshParts, formatMultiAccountRefresh } from "./plugin/auth";
import { AccountManager } from "./plugin/accounts";
import { promptProjectId, promptAddAnotherAccount } from "./plugin/cli";
import { startAntigravityDebugRequest } from "./plugin/debug";
import { createLogger, initLogger } from "./plugin/logger";
import { ensureProjectContext } from "./plugin/project";
import {
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./plugin/request";
import { getSessionId, toUrlString } from "./plugin/request-helpers";
import { executeSearch } from "./plugin/search";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import { loadAccounts, saveAccounts } from "./plugin/storage";
import { refreshAccessToken } from "./plugin/token";
import type {
  GetAuth,
  LoaderResult,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
  RefreshParts,
} from "./plugin/types";

const log = createLogger("plugin");

async function getAuthContext(
  getAuth: GetAuth,
  client: PluginContext["client"],
): Promise<{ accessToken: string; projectId: string } | null> {
  const auth = await getAuth();
  if (!isOAuthAuth(auth)) {
    return null;
  }

  let authRecord = auth;
  if (accessTokenExpired(authRecord)) {
    const refreshed = await refreshAccessToken(authRecord, client);
    if (!refreshed) {
      return null;
    }
    authRecord = refreshed;
  }

  const accessToken = authRecord.access;
  if (!accessToken) {
    return null;
  }

  try {
    const projectContext = await ensureProjectContext(authRecord, client);
    return { accessToken, projectId: projectContext.effectiveProjectId };
  } catch {
    return null;
  }
}

function createGoogleSearchTool(getAuth: GetAuth, client: PluginContext["client"]) {
  return tool({
    description: "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST extract those URLs and pass them in the 'urls' parameter for direct analysis.",
    args: {
      query: tool.schema.string().describe("The search query or question to answer using web search"),
      urls: tool.schema.array(tool.schema.string()).optional().describe("List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here."),
      thinking: tool.schema.boolean().optional().default(true).describe("Enable deep thinking for more thorough analysis (default: true)"),
    },
    async execute(args, _ctx) {
      log.debug("Google Search tool called", { query: args.query, urlCount: args.urls?.length ?? 0 });

      const authContext = await getAuthContext(getAuth, client);
      if (!authContext) {
        return "Error: Not authenticated with Antigravity. Please run `opencode auth login` to authenticate.";
      }

      return executeSearch(
        {
          query: args.query,
          urls: args.urls,
          thinking: args.thinking,
        },
        authContext.accessToken,
        authContext.projectId,
      );
    },
  });
}

/**
 * Performs OAuth flow for a single account.
 * Returns null if user cancels.
 */
async function authenticateSingleAccount(
  client: PluginContext["client"],
  isHeadless: boolean,
): Promise<{ refresh: string; access: string; expires: number; projectId: string; email?: string } | null> {
  let listener: OAuthListener | null = null;
  if (!isHeadless) {
    try {
      listener = await startOAuthListener();
    } catch (error) {
      await client.tui.showToast({
        body: {
          message: "Couldn't start callback listener. Falling back to manual copy/paste.",
          variant: "warning",
        },
      });
    }
  }

  const projectId = await promptProjectId();
  const authorization = await authorizeAntigravity(projectId);

  // Try to open the browser automatically
  if (!isHeadless) {
    try {
      if (process.platform === "darwin") {
        exec(`open "${authorization.url}"`);
      } else if (process.platform === "win32") {
        exec(`start "${authorization.url}"`);
      } else {
        exec(`xdg-open "${authorization.url}"`);
      }
    } catch (e) {
      await client.tui.showToast({
        body: {
          message: "Could not open browser automatically. Please copy/paste the URL.",
          variant: "warning",
        },
      });
    }
  }

  let result: AntigravityTokenExchangeResult;

  if (listener) {
    await client.tui.showToast({
      body: {
        message: "Waiting for browser authentication...",
        variant: "info",
      },
    });
    try {
      const callbackUrl = await listener.waitForCallback();
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");

      if (!code || !state) {
        await client.tui.showToast({
          body: {
            message: "Missing code or state in callback URL",
            variant: "error",
          },
        });
        return null;
      }

      result = await exchangeAntigravity(code, state);
    } catch (error) {
      await client.tui.showToast({
        body: {
          message: `Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          variant: "error",
        },
      });
      return null;
    } finally {
      try {
        await listener.close();
      } catch {}
    }
  } else {
    // Manual mode
    console.log("\n=== Antigravity OAuth Setup ===");
    console.log(`Open this URL in your browser: ${authorization.url}\n`);
    const { createInterface } = await import("node:readline/promises");
    const { stdin, stdout } = await import("node:process");
    const rl = createInterface({ input: stdin, output: stdout });

    try {
      const callbackUrlStr = await rl.question("Paste the full redirect URL here: ");
      const callbackUrl = new URL(callbackUrlStr);
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");

      if (!code || !state) {
        await client.tui.showToast({
          body: {
            message: "Missing code or state in callback URL",
            variant: "error",
          },
        });
        return null;
      }

      result = await exchangeAntigravity(code, state);
    } catch (error) {
      await client.tui.showToast({
        body: {
          message: `Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          variant: "error",
        },
      });
      return null;
    } finally {
      rl.close();
    }
  }

  if (result.type === "failed") {
    await client.tui.showToast({
      body: {
        message: `Authentication failed: ${result.error}`,
        variant: "error",
      },
    });
    return null;
  }

  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    projectId: result.projectId,
    email: result.email,
  };
}

/**
 * Registers the Antigravity OAuth provider for Opencode, handling auth, request rewriting,
 * debug logging, and response normalization for Antigravity Code Assist endpoints.
 */
export const AntigravityOAuthPlugin = async ({ client }: PluginContext): Promise<PluginResult> => {
  initLogger(client);

  let cachedGetAuth: GetAuth | null = null;

  return {
    auth: {
      provider: ANTIGRAVITY_PROVIDER_ID,
      loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>> => {
        cachedGetAuth = getAuth;
        const auth = await getAuth();
        if (!isOAuthAuth(auth)) {
          return {};
        }

        if (provider.models) {
          for (const model of Object.values(provider.models)) {
            if (model) {
              model.cost = { input: 0, output: 0 };
            }
          }
        }

        return {
          apiKey: "",
          async fetch(input, init) {
            if (!isGenerativeLanguageRequest(input)) {
              return fetch(input, init);
            }

            const latestAuth = await getAuth();
            if (!isOAuthAuth(latestAuth)) {
              return fetch(input, init);
            }

            // Load account storage for email metadata
            const storedAccounts = await loadAccounts();

            // Initialize AccountManager to handle multiple accounts
            const accountManager = new AccountManager(latestAuth, storedAccounts);
            const accountCount = accountManager.getAccountCount();

            // Helper to resolve project context
            const resolveProjectContext = async (authRecord: typeof latestAuth): Promise<ProjectContextResult> => {
              try {
                return await ensureProjectContext(authRecord, client);
              } catch (error) {
                throw error;
              }
            };

            // Try each account until one succeeds or all are rate-limited
            const maxAccountAttempts = accountCount;
            let accountAttempts = 0;

            while (accountAttempts < maxAccountAttempts) {
              const account = accountManager.getCurrentOrNext();

              if (!account) {
                // All accounts are rate-limited
                const waitTimeMs = accountManager.getMinWaitTime();
                const waitTimeSec = Math.ceil(waitTimeMs / 1000);

                log.error(`All ${accountCount} account(s) are rate-limited`, {
                  accountCount,
                  waitTimeSec,
                });

                throw new Error(
                  `All ${accountCount} account(s) are rate-limited. ` +
                    `Please wait ${waitTimeSec}s or add more accounts via 'opencode auth login'.`
                );
              }

              // Check if this is a new account switch
              const currentAccount = accountManager.getCurrentAccount();
              const isSwitch = !currentAccount || currentAccount.index !== account.index;

              if (isSwitch) {
                // Determine the reason for the switch
                const switchReason = currentAccount?.isRateLimited ? "rate-limit" : "initial";
                accountManager.markSwitched(account, switchReason);

                log.info(
                  `Using account ${account.index + 1}/${accountCount}${account.email ? ` (${account.email})` : ""}`,
                  {
                    accountIndex: account.index,
                    accountEmail: account.email,
                    accountCount,
                    reason: switchReason,
                  }
                );

                // Save account switch state
                try {
                  await accountManager.save();
                } catch (error) {
                  log.warn("Failed to save account switch state", {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }

              // Get auth for this specific account
              let authRecord = accountManager.accountToAuth(account);

              // Refresh token if expired
              if (accessTokenExpired(authRecord)) {
                const refreshed = await refreshAccessToken(authRecord, client);
                if (!refreshed) {
                  accountAttempts++;
                  continue;
                }
                authRecord = refreshed;
                const parts = parseRefreshParts(refreshed.refresh);
                accountManager.updateAccount(account, refreshed.access!, refreshed.expires!, parts);

                // Save updated account state
                try {
                  await accountManager.save();
                } catch (error) {
                  log.warn("Failed to save account state after token refresh", {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }

              const accessToken = authRecord.access;
              if (!accessToken) {
                accountAttempts++;
                continue;
              }

              const projectContext = await resolveProjectContext(authRecord);

              // Endpoint fallback logic: try daily → autopush → prod
              let lastError: Error | null = null;
              let lastResponse: Response | null = null;
              let hitRateLimit = false;

              for (let i = 0; i < CODE_ASSIST_ENDPOINT_FALLBACKS.length; i++) {
                const currentEndpoint = CODE_ASSIST_ENDPOINT_FALLBACKS[i];

                try {
                  const { request, init: transformedInit, streaming, requestedModel } = await prepareAntigravityRequest(
                    input,
                    init,
                    accessToken,
                    projectContext.effectiveProjectId,
                  );

                  // Override endpoint for fallback
                  const finalUrl = typeof request === "string" 
                    ? request.replace(/^https:\/\/[^\/]+/, currentEndpoint)
                    : request;

                  const originalUrl = toUrlString(input);
                  const resolvedUrl = toUrlString(finalUrl);
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

                  // Handle rate limiting - mark account and try next one
                  if (response.status === 429) {
                    const retryAfterHeader = response.headers.get("retry-after-ms") || response.headers.get("retry-after");
                    let retryAfterMs = 60000; // Default 60s

                    if (retryAfterHeader) {
                      const parsed = parseInt(retryAfterHeader, 10);
                      if (!isNaN(parsed)) {
                        // If header is in seconds (typical for Retry-After), convert to ms
                        retryAfterMs =
                          retryAfterHeader === response.headers.get("retry-after") ? parsed * 1000 : parsed;
                      }
                    }

                    accountManager.markRateLimited(account, retryAfterMs);
                    hitRateLimit = true;

                    log.info(`Account ${account.index + 1}/${accountCount} rate-limited${accountCount > 1 ? ', switching...' : ''}`, {
                      fromAccountIndex: account.index,
                      fromAccountEmail: account.email,
                      accountCount,
                      retryAfterMs,
                      reason: "rate-limit",
                    });

                    await client.tui.showToast({
                      body: {
                        message: accountCount > 1
                          ? `Rate limited on ${account.email || `Account ${account.index + 1}`}. Switching...`
                          : `Rate limited on ${account.email || 'your account'}. Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
                        variant: "warning",
                      },
                    });

                    // Save rate limit state
                    try {
                      await accountManager.save();
                    } catch (error) {
                      log.warn("Failed to save rate limit state", {
                        error: error instanceof Error ? error.message : String(error),
                      });
                    }

                    // Break out of endpoint loop to try next account
                    break;
                  }

                  // Handle server errors (500) on the last endpoint - treat as rate limit
                  if (response.status >= 500 && i === CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
                    const retryAfterMs = 60000; // 60 seconds default
                    accountManager.markRateLimited(account, retryAfterMs);
                    hitRateLimit = true;

                    log.warn(
                      `Account ${account.index + 1}/${accountCount} received ${response.status} error on all endpoints, rate-limiting...`,
                      {
                        fromAccountIndex: account.index,
                        fromAccountEmail: account.email,
                        accountCount,
                        status: response.status,
                        retryAfterMs,
                        reason: "server-error",
                      }
                    );

                    await client.tui.showToast({
                      body: {
                        message: accountCount > 1
                          ? `Server error on ${account.email || `Account ${account.index + 1}`}. Switching...`
                          : `Server error (${response.status}). Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
                        variant: "warning",
                      },
                    });

                    // Save rate limit state
                    try {
                      await accountManager.save();
                    } catch (error) {
                      log.warn("Failed to save rate limit state", {
                        error: error instanceof Error ? error.message : String(error),
                      });
                    }

                    break;
                  }

                  // Check if we should retry with next endpoint (but not for rate limits)
                  const shouldRetryEndpoint = response.status === 403 || response.status === 404 || response.status >= 500;

                  if (shouldRetryEndpoint && i < CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
                    // Try next endpoint
                    lastResponse = response;
                    continue;
                  }

                  // Success or final endpoint attempt - save updated auth and return
                  try {
                    // Save to OpenCode auth.json
                    await client.auth.set({
                      path: { id: ANTIGRAVITY_PROVIDER_ID },
                      body: accountManager.toAuthDetails(),
                    });

                    // Save to custom storage (preserves emails and metadata)
                    await accountManager.save();
                  } catch (saveError) {
                    log.error("Failed to save updated auth", {
                      error: saveError instanceof Error ? saveError.message : String(saveError),
                    });
                    await client.tui.showToast({
                      body: {
                        message: "Failed to save updated auth",
                        variant: "error",
                      },
                    });
                  }

                  return transformAntigravityResponse(response, streaming, client, debugContext, requestedModel, getSessionId());
                } catch (error) {
                  // Network error or other exception
                  if (i < CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    continue;
                  }

                  // Final endpoint attempt failed, throw the error
                  throw error;
                }
              }

              // If we hit a rate limit, try the next account
              if (hitRateLimit) {
                accountAttempts++;
                continue;
              }

              // If we get here, all endpoints failed for this account
              if (lastResponse) {
                // Return the last response even if it was an error
                const { streaming, requestedModel } = await prepareAntigravityRequest(
                  input,
                  init,
                  accessToken,
                  projectContext.effectiveProjectId,
                );
                const debugContext = startAntigravityDebugRequest({
                  originalUrl: toUrlString(input),
                  resolvedUrl: toUrlString(input),
                  method: init?.method,
                  headers: init?.headers,
                  body: init?.body,
                  streaming,
                  projectId: projectContext.effectiveProjectId,
                  sessionId: getSessionId(),
                });
                return transformAntigravityResponse(lastResponse, streaming, client, debugContext, requestedModel, getSessionId());
              }

              throw lastError || new Error("All Antigravity endpoints failed");
            }

            // Should never reach here, but just in case
            throw new Error("Failed to complete request with any account");
          },
        };
      },
      methods: [
        {
          label: "OAuth with Google (Antigravity)",
          type: "oauth",
          authorize: async () => {
            const isHeadless = !!(
              process.env.SSH_CONNECTION ||
              process.env.SSH_CLIENT ||
              process.env.SSH_TTY ||
              process.env.OPENCODE_HEADLESS
            );

            // Collect multiple accounts
            const accounts: Array<{
              refresh: string;
              access: string;
              expires: number;
              projectId: string;
              email?: string;
            }> = [];

            // Get first account
            const firstAccount = await authenticateSingleAccount(client, isHeadless);
            if (!firstAccount) {
              return {
                url: "",
                instructions: "Authentication cancelled",
                method: "auto",
                callback: async () => ({ type: "failed" as const, error: "Authentication cancelled" }),
              };
            }

            accounts.push(firstAccount);
            await client.tui.showToast({
              body: {
                message: `Account 1 authenticated${firstAccount.email ? ` (${firstAccount.email})` : ""}`,
                variant: "success",
              },
            });

            // Ask for additional accounts
            while (accounts.length < 10) {
              // Reasonable limit
              const addAnother = await promptAddAnotherAccount(accounts.length);
              if (!addAnother) {
                break;
              }

              const nextAccount = await authenticateSingleAccount(client, isHeadless);

              if (!nextAccount) {
                await client.tui.showToast({
                  body: {
                    message: "Skipping this account...",
                    variant: "warning",
                  },
                });
                continue;
              }

              accounts.push(nextAccount);
              await client.tui.showToast({
                body: {
                  message: `Account ${accounts.length} authenticated${nextAccount.email ? ` (${nextAccount.email})` : ""}`,
                  variant: "success",
                },
              });
            }

            const refreshParts: RefreshParts[] = accounts.map((acc) => ({
              refreshToken: acc.refresh,
              projectId: acc.projectId,
              managedProjectId: undefined,
            }));

            const combinedRefresh = formatMultiAccountRefresh({ accounts: refreshParts });

            // Save to custom storage with emails
            try {
              await saveAccounts({
                version: 1,
                accounts: accounts.map((acc, index) => ({
                  email: acc.email,
                  refreshToken: acc.refresh,
                  projectId: acc.projectId,
                  managedProjectId: undefined,
                  addedAt: Date.now(),
                  lastUsed: index === 0 ? Date.now() : 0,
                })),
                activeIndex: 0,
              });
            } catch (error) {
              // Log but don't fail authentication if storage fails
              console.error("[antigravity-auth] Failed to save account metadata:", error);
            }

            // Return a dummy authorization that immediately returns success with combined tokens
            const firstAcc = accounts[0]!;
            return {
              url: "",
              instructions: "Multi-account setup complete!",
              method: "auto",
              callback: async (): Promise<AntigravityTokenExchangeResult> => {
                return {
                  type: "success",
                  refresh: combinedRefresh,
                  access: firstAcc.access,
                  expires: firstAcc.expires,
                  email: firstAcc.email,
                  projectId: firstAcc.projectId,
                };
              },
            };
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
          prompts: [
            {
              type: "text",
              message: "Enter your Google API Key",
              key: "apiKey",
            },
          ],
        },
      ],
    },
    tool: {
      google_search: createGoogleSearchTool(() => {
        if (!cachedGetAuth) {
          throw new Error("Auth not initialized");
        }
        return cachedGetAuth();
      }, client),
    },
  };
};
