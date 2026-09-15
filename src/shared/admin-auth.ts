async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function verifyAdminBearer(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || !expectedToken) {
    return false;
  }
  const providedToken = authorization.slice("Bearer ".length);
  if (providedToken.length === 0 || /\s/.test(providedToken)) {
    return false;
  }
  const [providedHash, expectedHash] = await Promise.all([
    sha256(providedToken),
    sha256(expectedToken),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedHash.length; index += 1) {
    difference |= providedHash[index]! ^ expectedHash[index]!;
  }
  return difference === 0;
}
