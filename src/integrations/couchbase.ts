import { connect, Cluster, Collection } from 'couchbase';
import { loadEnv } from '../config/env.js';

class CouchbaseClient {
    private static cluster: Cluster | null = null;
    private static blacklist: Collection | null = null;

    static async init() {
        if (this.blacklist) return this.blacklist;

        this.cluster = await connect(loadEnv('couchbase'), {
            username: loadEnv('couchbase_user'),
            password: loadEnv('couchbase_pass'),
            configProfile: 'wanDevelopment',
            timeouts: { kvTimeout: 10000 },
        });

        const bucket = this.cluster.bucket('alice');
        const scope = bucket.scope('_default');

        try {
            await bucket.collections().createCollection({ name: 'blacklists', scopeName: '_default' });
            await new Promise(r => setTimeout(r, 1000));
        } catch {
        }

        this.blacklist = scope.collection('blacklists');
        await new Promise(r => setTimeout(r, 1500));

        return this.blacklist;
    }

    static getCluster() {
        if (!this.cluster) throw new Error('Couchbase not initialized');
        return this.cluster;
    }
}

export default CouchbaseClient;