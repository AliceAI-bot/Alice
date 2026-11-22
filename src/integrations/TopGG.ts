import { Api } from '@top-gg/sdk';

let apiInstance: Api | null = null;

export function initTopGG(token: string): void {
    if (!token) throw new Error('Top.gg token is required');

    // The SDK posts stats via the v0 API, which expects the raw token
    // (no `Bearer ` prefix). The .env value may carry the prefix for v1
    // vote checks, so strip it here to support either format.
    const rawToken = token.startsWith('Bearer ') ? token.slice('Bearer '.length) : token;

    apiInstance = new Api(rawToken);
    console.log('Top.gg API initialized');
}

export async function poststats(serverCount: number, shardCount?: number): Promise<void> {
    if (!apiInstance) {
        throw new Error('Top.gg API not initialized. Call initTopGG(token) first.');
    }

    const stats: { serverCount: number; shardCount?: number } = { serverCount };
    if (shardCount) stats.shardCount = shardCount;

    await apiInstance.postStats(stats);
}
