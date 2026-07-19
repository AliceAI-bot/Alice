import { DocumentNotFoundError, Collection } from 'couchbase';
import CouchbaseClient from '../integrations/couchbase.js';
import { encrypt, decrypt, hashKey } from '../integrations/crypto.js';

class BlacklistModel {
    constructor(private collection: Collection) {}

    async add(userId: string, reason = 'Unknown') {
        return this.collection.upsert(hashKey(userId), {
            reason: encrypt(reason),
            createdAt: Date.now(),
        });
    }

    async remove(userId: string) {
        return this.collection.remove(hashKey(userId));
    }

    async isBlacklisted(userId: string): Promise<boolean> {
        try {
            await this.collection.get(hashKey(userId));
            return true;
        } catch (err) {
            if (err instanceof DocumentNotFoundError) return false;
            throw err;
        }
    }

    async getReason(userId: string): Promise<string | null> {
        try {
            const doc = await this.collection.get(hashKey(userId));
            const raw = doc.content?.reason as string;
            try { return decrypt(raw); } catch { return raw; }
        } catch (err) {
            if (err instanceof DocumentNotFoundError) return null;
            throw err;
        }
    }
}

let Blacklist: BlacklistModel;

async function initDB() {
    const collection = await CouchbaseClient.init();
    Blacklist = new BlacklistModel(collection);
}

export { initDB, Blacklist };