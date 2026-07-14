// src/integrations/TopGG.ts
import { Api } from "@top-gg/sdk";

let apiInstance: Api | null = null;

export const initTopGG = (token: string): Api => {
    if (!token) {
        throw new Error("Top.gg token is required");
    }

    apiInstance = new Api(token);
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
        console.log(`Successfully posted stats to Top.gg: ${serverCount} servers${shardCount ? `, ${shardCount} shards` : ''}`);
    } catch (error) {
        console.error("Failed to post bot stats to Top.gg:", error);
        throw error;
    }
};