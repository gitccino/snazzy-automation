import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

const origin = "http://127.0.0.1:8765";
const callbackUrl = `${origin}/oauth/callback`;
type Fetcher = typeof fetch;
type DriveFile = { id?: unknown; mimeType?: unknown; parents?: unknown; driveId?: unknown };

export function buildAuthorization(clientId: string, redirectUri: string) {
  const state = Buffer.from(randomBytes(32)).toString("base64url");
  const codeVerifier = Buffer.from(randomBytes(32)).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/drive.file",
    access_type: "offline", prompt: "consent", state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  }).toString();
  return { url: url.toString(), state, codeVerifier };
}

export function validateOAuthCallback(requestUrl: string, expectedState: string): string {
  const params = new URL(requestUrl).searchParams;
  if (params.has("error")) throw new Error("Google authorization was denied");
  const states = params.getAll("state");
  if (states.length !== 1 || states[0]!.length !== expectedState.length ||
    !timingSafeEqual(Buffer.from(states[0]!), Buffer.from(expectedState))) throw new Error("OAuth state mismatch");
  const codes = params.getAll("code");
  if (codes.length !== 1 || !codes[0]) throw new Error("OAuth callback has no authorization code");
  return codes[0];
}

export async function completeOAuthCallback(
  requestUrl: string, expectedState: string, codeVerifier: string,
  credentials: { clientId: string; clientSecret: string; redirectUri: string },
  expectedOwner: string, fetcher: Fetcher = fetch,
) {
  const callback = new URL(requestUrl);
  if (`${callback.origin}${callback.pathname}` !== credentials.redirectUri) throw new Error("Unexpected OAuth callback");
  const code = validateOAuthCallback(requestUrl, expectedState);
  let response: Response;
  try {
    response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
        code, code_verifier: codeVerifier, redirect_uri: credentials.redirectUri, grant_type: "authorization_code" }),
    });
  } catch { throw new Error("Google token exchange failed"); }
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  let token: unknown;
  try { token = await response.json(); } catch { throw new Error("Invalid Google token response"); }
  if (!token || typeof token !== "object" ||
    typeof (token as Record<string, unknown>).access_token !== "string" || !(token as Record<string, unknown>).access_token ||
    typeof (token as Record<string, unknown>).refresh_token !== "string" || !(token as Record<string, unknown>).refresh_token) {
    throw new Error("Invalid Google token response");
  }
  const accessToken = (token as { access_token: string }).access_token;
  const refreshToken = (token as { refresh_token: string }).refresh_token;
  try {
    response = await fetcher("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch { throw new Error("Google userinfo request failed"); }
  if (!response.ok) throw new Error(`Google userinfo request failed (${response.status})`);
  let profile: unknown;
  try { profile = await response.json(); } catch { throw new Error("Invalid Google userinfo response"); }
  if (!profile || typeof profile !== "object" ||
    typeof (profile as Record<string, unknown>).email !== "string" ||
    (profile as Record<string, unknown>).email_verified !== true ||
    (profile as { email: string }).email.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error("Google account does not match the expected owner");
  }
  return { accessToken, refreshToken, email: (profile as { email: string }).email };
}

export function validatePickerSelection(folder: DriveFile, template: DriveFile) {
  if (typeof folder.id !== "string" || !folder.id || folder.mimeType !== "application/vnd.google-apps.folder" || folder.driveId !== undefined) {
    throw new Error("Select one My Drive folder");
  }
  if (typeof template.id !== "string" || !template.id || template.mimeType !== "application/vnd.google-apps.document" ||
    template.driveId !== undefined || !Array.isArray(template.parents) ||
    template.parents.length !== 1 || template.parents[0] !== folder.id) {
    throw new Error("Select one Google Doc inside that folder");
  }
  return { folderId: folder.id, templateId: template.id };
}

export async function fetchAndValidateSelection(folderId: string, templateId: string, accessToken: string, fetcher: Fetcher = fetch) {
  if (![folderId, templateId].every((id) => /^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new Error("Invalid Picker selection");
  async function file(id: string): Promise<DriveFile> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", "id,mimeType,parents,driveId");
    let response: Response;
    try { response = await fetcher(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } }); }
    catch { throw new Error("Google Drive metadata request failed"); }
    if (!response.ok) throw new Error(`Google Drive metadata request failed (${response.status})`);
    let metadata: unknown;
    try { metadata = await response.json(); }
    catch { throw new Error("Invalid Google Drive metadata"); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid Google Drive metadata");
    return metadata as DriveFile;
  }
  const folder = await file(folderId);
  const template = await file(templateId);
  if (folder.id !== folderId || template.id !== templateId) throw new Error("Google Drive returned unexpected files");
  return validatePickerSelection(folder, template);
}

export function createSelectionCompletion(
  accessToken: string, fetcher: Fetcher,
  onComplete: (ids: { folderId: string; templateId: string }) => void,
) {
  let completed = false;
  return async (folderId: string, templateId: string) => {
    const ids = await fetchAndValidateSelection(folderId, templateId, accessToken, fetcher);
    if (completed) return null;
    completed = true;
    onComplete(ids);
    return ids;
  };
}

export function hasSessionCookie(cookieHeader: string | undefined, expectedSessionCookie: string): boolean {
  return cookieHeader?.split(";").some((part) => part.trim() === `setup=${expectedSessionCookie}`) ?? false;
}

export function pickerPage(projectNumber: string, apiKey: string): string {
  const literal = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="referrer" content="origin"><title>Choose Google Drive template</title>
<main><h1>Choose your Google Drive template</h1><p>Pick a folder in My Drive, then a Google Doc inside it.</p>
<p><button id="folder" disabled>Choose folder</button> <span id="folder-id"></span></p>
<p><button id="template" disabled>Choose template</button> <span id="template-id"></span></p>
<button id="confirm" disabled>Confirm selection</button><p id="status" role="status"></p></main>
<script src="https://apis.google.com/js/api.js"></script><script>
const projectNumber = ${literal(projectNumber)}, apiKey = ${literal(apiKey)};
const status = document.getElementById('status');
let folderId, templateId;
gapi.load('picker', () => { document.getElementById('folder').disabled = false; });
function choose(type) {
  fetch('/session-token', { credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('Authorization session expired');
    return (await response.json()).accessToken;
  }).then(accessToken => {
    const view = type === 'folder'
      ? new google.picker.DocsView(google.picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true)
      : new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes('application/vnd.google-apps.document');
    view.setMode(google.picker.DocsViewMode.LIST);
    new google.picker.PickerBuilder().setAppId(projectNumber).setDeveloperKey(apiKey)
      .setOAuthToken(accessToken).setOrigin(location.origin).addView(view).setCallback(data => {
        if (data.action !== google.picker.Action.PICKED || data.docs?.length !== 1) return;
        const id = data.docs[0].id;
        if (type === 'folder') {
          folderId = id; templateId = undefined;
          document.getElementById('folder-id').textContent = id;
          document.getElementById('template-id').textContent = '';
          document.getElementById('template').disabled = false;
        } else { templateId = id; document.getElementById('template-id').textContent = id; }
        document.getElementById('confirm').disabled = !folderId || !templateId;
      }).build().setVisible(true);
  }).catch(() => { status.textContent = 'Could not open Google Picker. Retry or restart setup.'; });
}
document.getElementById('folder').onclick = () => choose('folder');
document.getElementById('template').onclick = () => choose('template');
document.getElementById('confirm').onclick = async () => {
  status.textContent = 'Checking Drive metadata…';
  try {
    const response = await fetch('/selection', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId, templateId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    status.textContent = 'Confirmed ' + result.email + ': ' + result.folderId + ' / ' + result.templateId + '. Return to the terminal.';
    document.getElementById('confirm').disabled = true;
  } catch (error) { status.textContent = error.message || 'Selection failed'; }
};
</script></html>`;
}

function send(response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "referrer-policy": "origin", "x-content-type-options": "nosniff" });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 4096) throw new Error("Invalid Picker selection");
  }
  try { return JSON.parse(body); } catch { throw new Error("Invalid Picker selection"); }
}

async function main() {
  if (!process.stdout.isTTY) throw new Error("Run this setup in an interactive terminal so the refresh token is not captured by a pipe or log");
  const ownerFlag = process.argv.indexOf("--expected-owner");
  const expectedOwner = process.argv[ownerFlag + 1]?.trim();
  if (ownerFlag < 0 || !expectedOwner || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    throw new Error("Usage: npm run google:drive-setup -- --expected-owner owner@example.com");
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const apiKey = process.env.GOOGLE_PICKER_API_KEY?.trim();
  const projectNumber = process.env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
  if (!clientId || !clientSecret || !apiKey || !projectNumber) throw new Error("Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_PICKER_API_KEY, and GOOGLE_CLOUD_PROJECT_NUMBER");
  const auth = buildAuthorization(clientId, callbackUrl);
  const sessionCookie = Buffer.from(randomBytes(32)).toString("base64url");
  let tokens: Awaited<ReturnType<typeof completeOAuthCallback>> | undefined;
  let completeSelection: ReturnType<typeof createSelectionCompletion> | undefined;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (request.headers.host !== "127.0.0.1:8765") return send(response, 400, "Invalid host");
      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        if (tokens) return send(response, 400, "Authorization already completed");
        tokens = await completeOAuthCallback(url.toString(), auth.state, auth.codeVerifier,
          { clientId, clientSecret, redirectUri: callbackUrl }, expectedOwner);
        const authorized = tokens;
        completeSelection = createSelectionCompletion(authorized.accessToken, fetch, (ids) => {
          process.stdout.write(`Confirmed owner: ${authorized.email}\nGOOGLE_DRIVE_FOLDER_ID=${ids.folderId}\nGOOGLE_TEMPLATE_DOC_ID=${ids.templateId}\n`);
          process.stdout.write("Enter the refresh token through Wrangler's interactive prompt:\n  npx wrangler secret put GOOGLE_REFRESH_TOKEN --env staging\n  npx wrangler secret put GOOGLE_REFRESH_TOKEN --env production\n");
          process.stdout.write(`Refresh token (shown once): ${authorized.refreshToken}\n`);
        });
        response.setHeader("set-cookie", `setup=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/`);
        return send(response, 200, pickerPage(projectNumber, apiKey), "text/html; charset=utf-8");
      }
      if (!tokens || !hasSessionCookie(request.headers.cookie, sessionCookie)) return send(response, 403, "Authorize first");
      if (request.method === "GET" && url.pathname === "/session-token") {
        return send(response, 200, JSON.stringify({ accessToken: tokens.accessToken }), "application/json; charset=utf-8");
      }
      if (request.method === "POST" && url.pathname === "/selection") {
        if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") return send(response, 403, "Invalid request");
        const selection = await readJson(request);
        if (!selection || typeof selection !== "object" ||
          typeof (selection as Record<string, unknown>).folderId !== "string" ||
          typeof (selection as Record<string, unknown>).templateId !== "string") throw new Error("Invalid Picker selection");
        if (!completeSelection) throw new Error("Invalid Picker selection");
        const ids = await completeSelection((selection as { folderId: string }).folderId,
          (selection as { templateId: string }).templateId);
        if (!ids) return send(response, 409, JSON.stringify({ error: "Selection already completed" }), "application/json; charset=utf-8");
        send(response, 200, JSON.stringify({ ...ids, email: tokens.email }), "application/json; charset=utf-8");
        server.close();
        return;
      }
      send(response, 404, "Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Setup failed";
      const safe = /^(Google authorization was denied|OAuth state mismatch|OAuth callback has no authorization code|Unexpected OAuth callback|Google token exchange failed(?: \(\d+\))?|Invalid Google token response|Google userinfo request failed(?: \(\d+\))?|Invalid Google userinfo response|Google account does not match the expected owner|Invalid Picker selection|Select one My Drive folder|Select one Google Doc inside that folder|Google Drive metadata request failed(?: \(\d+\))?|Invalid Google Drive metadata|Google Drive returned unexpected files)$/.test(message) ? message : "Setup failed";
      send(response, 400, JSON.stringify({ error: safe }), "application/json; charset=utf-8");
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(8765, "127.0.0.1", resolve); });
  process.stdout.write(`Open this URL in the browser signed in as ${expectedOwner}:\n${auth.url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Setup failed"}\n`);
    process.exitCode = 1;
  });
}
