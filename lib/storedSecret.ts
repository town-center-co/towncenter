import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const PREFIX = "enc:v1";

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET is missing or too short (32 characters minimum).");
  }
  return createHmac("sha256", secret)
    .update("towncenter:stored-secret:v1")
    .digest();
}

export function sealStoredSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    PREFIX,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openStoredSecret(value: string): string {
  if (!value.startsWith(`${PREFIX}.`)) return value;

  const [prefix, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (prefix !== PREFIX || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Stored account secret has an unreadable format.");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Stored account secret could not be decrypted.");
  }
}
