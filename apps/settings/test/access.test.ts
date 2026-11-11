// @vitest-environment node
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { expect, it } from "vitest";
import { requireAccess } from "../worker/access";
it("verifies signed Access JWTs and rejects absent, forged, expired, wrong-audience and wrong-issuer tokens", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const key = {
    ...(await exportJWK(publicKey)),
    kid: "test",
    alg: "RS256",
    use: "sig",
  };
  const env = {
    ACCESS_TEAM_DOMAIN: "snazzy-test.cloudflareaccess.com",
    ACCESS_AUD: "settings-audience",
    SETTINGS_ORIGIN: "https://settings.example",
  };
  const fetcher: typeof fetch = async (input) => {
    expect(String(input)).toBe(
      "https://snazzy-test.cloudflareaccess.com/cdn-cgi/access/certs",
    );
    return Response.json({ keys: [key] });
  };
  const sign = (
    aud = env.ACCESS_AUD,
    iss = `https://${env.ACCESS_TEAM_DOMAIN}`,
    expiration = "1h",
  ) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuedAt()
      .setSubject("test-user")
      .setIssuer(iss)
      .setAudience(aud)
      .setExpirationTime(expiration)
      .sign(privateKey);
  const request = (token?: string) =>
    new Request("https://settings.example/api/settings", {
      headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
    });
  await expect(
    requireAccess(request(await sign()), env, fetcher),
  ).resolves.toBeUndefined();
  for (const token of [
    undefined,
    "forged",
    await sign("old-admin-audience"),
    await sign(env.ACCESS_AUD, "https://wrong.cloudflareaccess.com"),
    await sign(env.ACCESS_AUD, `https://${env.ACCESS_TEAM_DOMAIN}`, "-1h"),
  ])
    await expect(requireAccess(request(token), env, fetcher)).rejects.toThrow();
});
