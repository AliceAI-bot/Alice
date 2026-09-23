import { Api } from "@top-gg/sdk";

let apiInstance: Api | null = null;

export const initTopGG = (token: string): Api => {
    if (!token) {
        throw new Error("Top.gg token is required");
    }

    // The SDK posts stats via the v0 API, which expects the raw token
    // (no `Bearer ` prefix). The .env value may carry the prefix for v1
    // vote checks, so strip it here to support either format.
    const rawToken = token.startsWith('Bearer ') ? token.slice('Bearer '.length) : token;

    apiInstance = new Api(rawToken);
    console.log("Top.gg API initialized");
    return apiInstance;
};

export const poststats = async (serverCount: number, shardCount?: number): Promise<void> => {
    if (!apiInstance) {
        throw new Error("Top.gg API not initialized. Call initTopGG(token) first.");
    }

    if (typeof serverCount !== 'number' || serverCount < 0) {
        throw new Error("Invalid serverCount provided");
    }

    try {
        const stats: { serverCount: number; shardCount?: number } = { serverCount };
        if (shardCount) stats.shardCount = shardCount;

        await apiInstance.postStats(stats);
    } catch (error) {
        console.error("Failed to post bot stats to Top.gg:", error);
        throw error;
    }
};