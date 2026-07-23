import { connect, Cluster, Collection } from 'couchbase';
import { loadEnv } from '../config/env.js';

interface Collections {
    users: Collection;
    channels: Collection;
    characters: Collection;
}

class CouchbaseClient {
    private static cluster: Cluster | null = null;
    private static collections: Collections | null = null;
    private static readonly COLLECTIONS: (keyof Collections)[] = ['users', 'channels', 'characters'];

    static async init(): Promise<Collections> {
        if (this.collections) return this.collections;

        this.cluster = await connect(loadEnv('couchbase'), {
            username: loadEnv('couchbase_user'),
            password: loadEnv('couchbase_pass'),
            configProfile: 'wanDevelopment',
            timeouts: { kvTimeout: 10000 },
        });

        const bucket = this.cluster.bucket('alice');
        const scope = bucket.scope('_default');

        await this.ensureCollections(bucket);
        await new Promise(r => setTimeout(r, 1500));

        this.collections = {
            users: scope.collection('users'),
            channels: scope.collection('channels'),
            characters: scope.collection('characters'),
        };

        return this.collections;
    }

    private static async ensureCollections(bucket: any): Promise<void> {
        const mgr = bucket.collections();
        let existing: string[] = [];

        try {
            const scopes = await mgr.getAllScopes();
            existing = scopes.find((s: any) => s.name === '_default')?.collections.map((c: any) => c.name) ?? [];
        } catch {
            // Scope might not exist yet, collections will fail individually
        }

        for (const name of this.COLLECTIONS) {
            if (existing.includes(name)) continue;

            try {
                await mgr.createCollection({ name, scopeName: '_default' });
                await new Promise(r => setTimeout(r, 800));
            } catch (err: any) {
                // Already exists (race) or no permission — non-fatal
                if (!err.message?.includes('already exists')) {
                    console.warn(`[couchbase] Collection '${name}' creation failed:`, err.message);
                }
            }
        }
    }

    static getCluster(): Cluster {
        if (!this.cluster) throw new Error('Couchbase not initialized. Call init() first.');
        return this.cluster;
    }

    static getCollections(): Collections {
        if (!this.collections) throw new Error('Couchbase not initialized. Call init() first.');
        return this.collections;
    }

    static async close(): Promise<void> {
        if (!this.cluster) return;
        await this.cluster.close();
        this.cluster = null;
        this.collections = null;
    }
}

export default CouchbaseClient;