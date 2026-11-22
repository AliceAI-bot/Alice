import { connect, Collection, Bucket } from 'couchbase';
import { loadEnv } from '../config/env.js';

interface Collections {
    users: Collection;
    guilds: Collection;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class CouchbaseClient {
    private static collections: Collections | null = null;
    private static readonly COLLECTIONS: (keyof Collections)[] = ['users', 'guilds'];

    static async init(): Promise<Collections> {
        if (this.collections) return this.collections;

        const cluster = await connect(loadEnv('couchbase'), {
            username: loadEnv('couchbase_user'),
            password: loadEnv('couchbase_pass'),
            configProfile: 'wanDevelopment',
            timeouts: { kvTimeout: 10000 },
        });

        const bucket = cluster.bucket('alice');
        const scope = bucket.scope('_default');

        await this.ensureCollections(bucket);
        await sleep(1500);

        this.collections = {
            users: scope.collection('users'),
            guilds: scope.collection('guilds'),
        };

        return this.collections;
    }

    private static async ensureCollections(bucket: Bucket): Promise<void> {
        const mgr = bucket.collections();
        let existing: string[] = [];

        try {
            const scopes = await mgr.getAllScopes();
            existing = scopes.find((s) => s.name === '_default')?.collections.map((c) => c.name) ?? [];
        } catch {
            // Scope might not exist yet, collections will fail individually
        }

        for (const name of this.COLLECTIONS) {
            if (existing.includes(name)) continue;

            try {
                await mgr.createCollection({ name, scopeName: '_default' });
                await sleep(800);
            } catch (err) {
                // Already exists (race) or no permission — non-fatal
                const message = err instanceof Error ? err.message : String(err);
                if (!message.includes('already exists')) {
                    console.warn(`[couchbase] Collection '${name}' creation failed:`, message);
                }
            }
        }
    }
}

export default CouchbaseClient;
