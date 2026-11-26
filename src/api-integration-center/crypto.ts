/**
 * Credential encryption for the API Integration Center.
 *
 * The master key is deliberately separate from SESSION_JWT_SECRET and is never
 * written to the database, logs, API responses or the frontend. When no valid
 * key is configured the module fails closed: no credential can be stored or
 * read, and the UI reports PROVIDER_UNAVAILABLE instead of a fake success.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MASTER_KEY_ENV = 'API_INTEGRATIONS_MASTER_KEY';
export const MASTER_KEY_FILE_ENV = 'API_INTEGRATIONS_MASTER_KEY_FILE';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=?$/;

let cachedKey: Buffer | null | undefined;

function aadFor(workspaceId: string, providerKey: string): Buffer {
  return Buffer.from(`${workspaceId}\u0000${providerKey}`, 'utf8');
}

/** Reads and validates 32 base64-encoded key bytes. Never logs the value. */
export function resolveMasterKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const inline = String(process.env[MASTER_KEY_ENV] ?? '').trim();
  const file = String(process.env[MASTER_KEY_FILE_ENV] ?? '').trim();
  let raw = inline;
  if (!raw && file) {
    try {
      raw = readFileSync(file, 'utf8').trim();
    } catch {
      cachedKey = null;
      return cachedKey;
    }
  }
  if (!BASE64_32_BYTES.test(raw)) {
    cachedKey = null;
    return cachedKey;
  }
  const key = Buffer.from(raw, 'base64');
  cachedKey = key.length === 32 ? key : null;
  return cachedKey;
}

/** Test-only cache reset when the environment changes inside one process. */
export function resetMasterKeyCache(): void {
  cachedKey = undefined;
}

export function credentialStoreAvailable(): boolean {
  return resolveMasterKey() !== null;
}

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  tag: string;
  /** Non-reversible fingerprint; never a fragment of the secret. */
  hint: string;
}

/** Encrypts a credential payload bound to one workspace and provider. */
export function encryptCredential(payload: Record<string, unknown>, workspaceId: string, providerKey: string): EncryptedCredential {
  const key = resolveMasterKey();
  if (!key) throw new Error('CREDENTIAL_STORE_NOT_CONFIGURED');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadFor(workspaceId, providerKey));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const fingerprint = createHash('sha256')
    .update(aadFor(workspaceId, providerKey))
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 12);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    hint: `sha256:${fingerprint}`,
  };
}

/** Decrypts only with the same workspace/provider AAD; tampering fails closed. */
export function decryptCredential<T = Record<string, unknown>>(
  row: { ciphertext: string; iv: string; tag: string },
  workspaceId: string,
  providerKey: string,
): T {
  const key = resolveMasterKey();
  if (!key) throw new Error('CREDENTIAL_STORE_NOT_CONFIGURED');
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, 'base64'));
    decipher.setAAD(aadFor(workspaceId, providerKey));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_CREDENTIAL');
    return parsed as T;
  } catch {
    throw new Error('CREDENTIAL_DECRYPT_FAILED');
  }
}
