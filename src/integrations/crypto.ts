import { randomBytes, createCipheriv, createDecipheriv, scryptSync, createHash } from 'crypto';
import { loadEnv } from '../config/env.js';

const password = loadEnv('encryption_key');
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
    const parts = encrypted.split('.');
    
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted data format');
    }

    const ivHex = parts[0]!;
    const authTagHex = parts[1]!;
    const encryptedData = parts[2]!;
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}

export function hashKey(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}  // putting this function here cuz ig it does the similar job


// people in the support server are wierd, i think they might be pregnent