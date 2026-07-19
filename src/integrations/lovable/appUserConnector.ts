// Server-only helpers for App User Connectors. Never import from browser code.
function requireApiKey(): string {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not set.");
  return key;
}

export interface AppUserOAuthAuthorizeParams {
  gatewayBaseUrl: string;
  connectorId: string;
  appUserId: string;
  clientAPIKey: string;
  returnUrl: string;
  credentialsConfiguration?: Record<string, unknown>;
  responseMode?: "redirect" | "web_message";
  webMessageTargetOrigin?: string;
}

export async function authorizeAppUserOAuth(
  p: AppUserOAuthAuthorizeParams,
): Promise<{ authorizationUrl: string; sessionId: string }> {
  const res = await fetch(`${p.gatewayBaseUrl}/api/v1/app-users/oauth2/authorize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
      "X-Client-Api-Key": p.clientAPIKey,
    },
    body: JSON.stringify({
      connector_id: p.connectorId,
      app_user_id: p.appUserId,
      return_url: p.returnUrl,
      credentials_configuration: p.credentialsConfiguration,
      response_mode: p.responseMode,
      web_message_target_origin: p.webMessageTargetOrigin,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth start failed (${res.status}): ${text}`);
  const body = JSON.parse(text) as { authorization_url?: string; session_id?: string };
  if (!body.authorization_url) throw new Error("Missing authorization_url");
  return { authorizationUrl: body.authorization_url, sessionId: body.session_id ?? "" };
}

export async function callAsAppUser(opts: {
  gatewayBaseUrl: string;
  connectionAPIKey: string;
  connectorId: string;
  path: string;
  init?: RequestInit;
}): Promise<Response> {
  const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const headers = new Headers(opts.init?.headers);
  headers.set("Authorization", `Bearer ${requireApiKey()}`);
  headers.set("X-Connection-Api-Key", opts.connectionAPIKey);
  return fetch(`${opts.gatewayBaseUrl}/${opts.connectorId}${path}`, { ...opts.init, headers });
}

export async function disconnectAppUser(opts: {
  gatewayBaseUrl: string;
  connectionAPIKey: string;
  connectorId: string;
}): Promise<void> {
  const res = await fetch(`${opts.gatewayBaseUrl}/api/v1/app-users/connection`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "X-Connection-Api-Key": opts.connectionAPIKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ connector_id: opts.connectorId }),
  });
  if (!res.ok) throw new Error(`Disconnect failed (${res.status}): ${await res.text()}`);
}
