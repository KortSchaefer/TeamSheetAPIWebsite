const encoder = new TextEncoder();

interface JwtPayload {
  sub: string;
  exp: number;
}

function encodeBase64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createToken(
  userId: number,
  secret: string,
  expiresMinutes: number,
): Promise<string> {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      sub: String(userId),
      exp: Math.floor(Date.now() / 1000) + expiresMinutes * 60,
    } satisfies JwtPayload),
  );
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(unsigned),
  );
  return `${unsigned}.${encodeBase64Url(signature)}`;
}

export async function verifyToken(token: string, secret: string): Promise<number | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerValue, payloadValue, signatureValue] = parts;
    const header: unknown = JSON.parse(decodeBase64Url(headerValue));
    if (
      typeof header !== "object" ||
      header === null ||
      !("alg" in header) ||
      header.alg !== "HS256"
    ) {
      return null;
    }

    const verified = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      Uint8Array.from(
        atob(signatureValue.replaceAll("-", "+").replaceAll("_", "/").padEnd(
          Math.ceil(signatureValue.length / 4) * 4,
          "=",
        )),
        (character) => character.charCodeAt(0),
      ),
      encoder.encode(`${headerValue}.${payloadValue}`),
    );
    if (!verified) return null;

    const payload: unknown = JSON.parse(decodeBase64Url(payloadValue));
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("sub" in payload) ||
      typeof payload.sub !== "string" ||
      !("exp" in payload) ||
      typeof payload.exp !== "number" ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    const userId = Number(payload.sub);
    return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}
