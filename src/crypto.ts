import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, 'mailhub-api-key-enc', 32);
}

export function encryptApiKey(plainKey: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptApiKey(encrypted: string, secret: string): string | null {
  try {
    const key = deriveKey(secret);
    const buf = Buffer.from(encrypted, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}
