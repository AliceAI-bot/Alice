import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { loadEnv } from '../config/env.js';

const password = loadEnv('encryption_key');
if (!password) {
    throw new Error('Missing encryption_key in .env — refusing to encrypt with a weak fallback key.');
}

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
    if (!cachedKey) {
        const salt = Buffer.from('alice-encryption-key-salt-16b!');
        cachedKey = scryptSync(password, salt, 32);
    }
    return cachedKey;
}

export function encrypt(data: string): string {
    const key = getKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}.${authTag.toString('hex')}.${encrypted}`;
}

export function decrypt(encrypted: string): string {
    const key = getKey();
    const [ivHex, authTagHex, encryptedData, ...extra] = encrypted.split('.');

    if (ivHex === undefined || authTagHex === undefined || encryptedData === undefined || extra.length) {
        throw new Error('Invalid encrypted data format');
    }

    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

export function hashKey(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}
