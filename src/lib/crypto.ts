import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import { getEnv } from "@/env";

/**
 * Symmetric encryption for secrets stored at rest (per-brand Crisp keys).
 * AES-256-GCM with a key derived from CREDENTIALS_SECRET (falls back to
 * BASIC_AUTH_PASSWORD, then a dev constant with a warning). Server-only.
 */

let warned = false;

function secretMaterial(): string {
  const env = getEnv();
  const secret = env.CREDENTIALS_SECRET || env.BASIC_AUTH_PASSWORD;
  if (!secret) {
    if (!warned) {
      console.warn(
        "[crypto] Neither CREDENTIALS_SECRET nor BASIC_AUTH_PASSWORD is set — " +
          "brand Crisp keys are encrypted with an insecure default. Set " +
          "CREDENTIALS_SECRET before storing real tokens."
      );
      warned = true;
    }
    return "yayassist-insecure-dev-secret";
  }
  return secret;
}

let cachedKey: { material: string; key: Buffer } | null = null;

function derivedKey(): Buffer {
  const material = secretMaterial();
  if (cachedKey && cachedKey.material === material) return cachedKey.key;
  // Fixed salt: the secret is the confidential input; a stable salt keeps
  // decryption deterministic across restarts.
  const key = scryptSync(material, "yayassist.credentials.v1", 32);
  cachedKey = { material, key };
  return key;
}

/** Encrypt a plaintext secret → "v1:iv:tag:ciphertext" (all base64). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** Decrypt a payload produced by encryptSecret. Throws on tamper/format. */
export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unrecognized encrypted secret format");
  }
  const [, ivB, tagB, dataB] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    derivedKey(),
    Buffer.from(ivB, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
