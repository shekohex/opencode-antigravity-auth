import { beforeEach, describe, expect, it, mock } from "bun:test";

import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token|project-123",
  access: "old-access",
  expires: Date.now() - 1000,
};

function createClient() {
  return {
    auth: {
      set: mock(async () => {}),
    },
  } as unknown as PluginClient & {
    auth: { set: ReturnType<typeof mock<(input: any) => Promise<void>>> };
  };
}

describe("refreshAccessToken", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("updates the caller and returns refreshed token", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("new-access");
    // Note: refreshAccessToken no longer saves immediately - caller handles saving
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("handles when Google rotates the refresh token", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
          refresh_token: "rotated-token",
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("next-access");
    expect(result?.refresh).toContain("rotated-token");
    // Note: refreshAccessToken no longer saves immediately - caller handles saving
    expect(client.auth.set.mock.calls.length).toBe(0);
  });
});
