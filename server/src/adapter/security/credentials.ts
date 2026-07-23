import {
  randomBytes,
  scrypt,
  timingSafeEqual
} from "node:crypto";

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export function generateCredentialSecret(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

export async function hashCredentialSecret(secret: string): Promise<string> {
  requireSecret(secret);
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(secret, salt);
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    hash.toString("base64url")
  ].join("$");
}

export async function verifyCredentialSecret(
  secret: string,
  encodedHash: string
): Promise<boolean> {
  requireSecret(secret);
  const [algorithm, cost, blockSize, parallelization, saltValue, hashValue] =
    encodedHash.split("$");
  if (
    algorithm !== "scrypt" ||
    cost !== String(SCRYPT_COST) ||
    blockSize !== String(SCRYPT_BLOCK_SIZE) ||
    parallelization !== String(SCRYPT_PARALLELIZATION) ||
    saltValue === undefined ||
    hashValue === undefined
  ) {
    return false;
  }

  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = await derive(secret, Buffer.from(saltValue, "base64url"));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function redactCredentialSecret(_secret: string): "[REDACTED]" {
  return "[REDACTED]";
}

export const credentialService = {
  generateSecret: generateCredentialSecret,
  hashSecret: hashCredentialSecret,
  verifySecret: verifyCredentialSecret
};

function derive(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_BYTES, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: 64 * 1024 * 1024
    }, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function requireSecret(secret: string): void {
  if (secret.length < 32) {
    throw new Error("credential secret must contain at least 32 characters");
  }
}
