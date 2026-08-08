import { compare } from "bcryptjs";

const encoder = new TextEncoder();
const PASSLIB_BCRYPT_SHA256_V2 =
  /^\$bcrypt-sha256\$v=2,t=(2b),r=(\d{1,2})\$([^$]{22})\$([^$]{31})$/;
const PASSLIB_BCRYPT_SHA256_V1 =
  /^\$bcrypt-sha256\$(2[ab]),(\d{1,2})\$([^$]{22})\$([^$]{31})$/;
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll(".", "+").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodePasslibBase64(value: ArrayBuffer): string {
  return encodeBase64(value).replaceAll("+", ".").replaceAll("=", "");
}

/** Create a hash that remains readable by FastAPI's Passlib CryptContext. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const rounds = 29_000;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds },
    key,
    256,
  );
  return `$pbkdf2-sha256$${rounds}$${encodePasslibBase64(salt.buffer)}$${encodePasslibBase64(derived)}`;
}

async function verifyPbkdf2(password: string, hash: string): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 5 || parts[1] !== "pbkdf2-sha256") return false;

  const rounds = Number(parts[2]);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 0xffffffff) return false;

  const expected = decodeBase64(parts[4]);
  if (expected.byteLength !== 32) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: decodeBase64(parts[3]),
      iterations: rounds,
    },
    key,
    256,
  );
  return crypto.subtle.timingSafeEqual(derived, expected);
}

async function bcryptSha256Key(
  password: string,
  salt: string,
  version: 1 | 2,
): Promise<string> {
  let digest: ArrayBuffer;
  if (version === 1) {
    digest = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  } else {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(salt),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    digest = await crypto.subtle.sign("HMAC", key, encoder.encode(password));
  }
  return encodeBase64(digest);
}

async function verifyBcryptSha256(password: string, hash: string): Promise<boolean> {
  const v2 = PASSLIB_BCRYPT_SHA256_V2.exec(hash);
  const v1 = v2 === null ? PASSLIB_BCRYPT_SHA256_V1.exec(hash) : null;
  const match = v2 ?? v1;
  if (match === null) return false;

  const [, ident, roundsValue, salt, checksum] = match;
  const rounds = Number(roundsValue);
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) return false;

  const key = await bcryptSha256Key(password, salt, v2 === null ? 1 : 2);
  return compare(
    key,
    `$${ident}$${rounds.toString().padStart(2, "0")}$${salt}${checksum}`,
  );
}

/** Verify every scheme accepted by the FastAPI Passlib CryptContext. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    if (hash.startsWith("$pbkdf2-sha256$")) return await verifyPbkdf2(password, hash);
    if (hash.startsWith("$bcrypt-sha256$")) return await verifyBcryptSha256(password, hash);
    if (BCRYPT.test(hash)) return await compare(password, hash);
    return false;
  } catch {
    return false;
  }
}
