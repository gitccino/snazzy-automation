import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
export interface AccessEnv {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  SETTINGS_ORIGIN: string;
}
export async function requireAccess(
  request: Request,
  env: AccessEnv,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const domain = env.ACCESS_TEAM_DOMAIN;
  if (
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) ||
    !env.ACCESS_AUD ||
    new URL(request.url).origin !== env.SETTINGS_ORIGIN
  )
    throw new Error("unauthorized");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("unauthorized");
  const issuer = `https://${domain}`;
  await jwtVerify(
    token,
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      [customFetch]: fetcher,
    }),
    {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
    },
  );
}
