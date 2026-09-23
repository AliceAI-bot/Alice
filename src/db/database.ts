import { DocumentExistsError, DocumentNotFoundError, PathNotFoundError, Collection, MutateInSpec } from 'couchbase';
import CouchbaseClient from '../integrations/couchbase.js';
import { encrypt, decrypt, hashKey } from '../integrations/crypto.js';
import { RelationshipState, createRelationship } from '../utils/relationship.js';

export type Tier = 'free' | 'premium' | 'byok';

export type { RelationshipStatus } from '../utils/relationship.js';

export interface UserData {
    acceptedAt: number;
    tier: Tier;
    premiumExpiry: number | null;
    byokKey: string | null;
    stats: {
        messagesSent: number;
        firstSeen: number;
    };
    badges: string[];
    relationship: RelationshipState;
    memories: string[];
    blacklisted: boolean;
    blacklistReason: string | null;
}

export interface ChannelConfig {
    persona: string;
    channelId: string;
}

export interface GuildData {
    channels: Record<string, ChannelConfig>;
    createdAt: number;
}

export interface GateData {
    accepted: boolean;
    blacklisted: boolean;
    reason: string | null;
}

// In-process read-through cache for user documents. Every mutating method
// invalidates/updates it, so same-process writes are always coherent; writes
// from other processes become visible within USER_CACHE_TTL_MS.
const USER_CACHE_TTL_MS = 3 * 60 * 1000;
const USER_CACHE_MAX = 2000;

interface UserCacheEntry {
    data: UserData;
    expiresAt: number;
}

const userCache = new Map<string, UserCacheEntry>();

function cloneUser(data: UserData): UserData {
    return {
        ...data,
        stats: { ...data.stats },
        badges: [...data.badges],
        relationship: { ...data.relationship },
        memories: [...data.memories],
    };
}

function userCacheGet(userId: string): UserData | null {
    const entry = userCache.get(userId);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
        userCache.delete(userId);
        return null;
    }

    // Refresh LRU position.
    userCache.delete(userId);
    userCache.set(userId, entry);
    return cloneUser(entry.data);
}

function userCacheSet(userId: string, data: UserData): void {
    userCache.delete(userId);
    userCache.set(userId, { data: cloneUser(data), expiresAt: Date.now() + USER_CACHE_TTL_MS });

    if (userCache.size > USER_CACHE_MAX) {
        const oldest = userCache.keys().next().value;
        if (oldest !== undefined) userCache.delete(oldest);
    }
}

function userCachePatch(
    userId: string,
    patch: (data: UserData) => void,
): void {
    const entry = userCache.get(userId);
    if (!entry || entry.expiresAt <= Date.now()) return;
    patch(entry.data);
}

class UsersModel {
    constructor(private collection: Collection) {}

    private serialize(data: UserData): UserData {
        return {
            ...data,
            byokKey: data.byokKey ? encrypt(data.byokKey) : null,
            blacklistReason: data.blacklistReason ? encrypt(data.blacklistReason) : null,
        };
    }

    async get(userId: string): Promise<UserData | null> {
        const cached = userCacheGet(userId);
        if (cached) return cached;

        try {
            const doc = await this.collection.get(hashKey(userId));
            const raw = doc.content as any;

            const data: UserData = {
                ...raw,
                byokKey: raw.byokKey ? decrypt(raw.byokKey) : null,
                blacklistReason: raw.blacklistReason ? decrypt(raw.blacklistReason) : null,
            };
            userCacheSet(userId, data);
            return cloneUser(data);
        } catch (err) {
            if (err instanceof DocumentNotFoundError) return null;
            throw err;
        }
    }

    async ensure(userId: string): Promise<UserData> {
        const existing = await this.get(userId);
        if (existing) return existing;

        const fresh: UserData = {
            acceptedAt: Date.now(),
            tier: 'free',
            premiumExpiry: null,
            byokKey: null,
            stats: { messagesSent: 0, firstSeen: Date.now() },
            badges: [],
            relationship: createRelationship(),
            memories: [],
            blacklisted: false,
            blacklistReason: null,
        };

        try {
            await this.collection.insert(hashKey(userId), fresh);
        } catch (err) {
            // Lost the first-seen race with another process — read their doc.
            if (!(err instanceof DocumentExistsError)) throw err;
            const winner = await this.get(userId);
            if (!winner) throw err;
            return winner;
        }
        userCacheSet(userId, fresh);
        return cloneUser(fresh);
    }

    async update(userId: string, patch: Partial<UserData>, base?: UserData): Promise<void> {
        const existing = base ?? (await this.get(userId));
        if (!existing) throw new Error('User not found');

        await this.collection.upsert(hashKey(userId), this.serialize({ ...existing, ...patch }));
        userCacheSet(userId, { ...existing, ...patch });
    }

    async getGateData(userId: string): Promise<GateData> {
        const user = await this.get(userId);
        if (!user) return { accepted: false, blacklisted: false, reason: null };
        return { accepted: true, blacklisted: user.blacklisted, reason: user.blacklistReason };
    }

    async blacklist(userId: string, reason = 'Unknown'): Promise<void> {
        await this.update(userId, { blacklisted: true, blacklistReason: reason });
    }

    async unblacklist(userId: string): Promise<void> {
        await this.update(userId, { blacklisted: false, blacklistReason: null });
    }

    async isBlacklisted(userId: string): Promise<boolean> {
        const gate = await this.getGateData(userId);
        return gate.blacklisted;
    }

    async getBlacklistReason(userId: string): Promise<string | null> {
        return (await this.get(userId))?.blacklistReason ?? null;
    }

    async saveInteraction(
        userId: string,
        _base: UserData,
        rel: RelationshipState,
        memories?: string[],
    ): Promise<void> {
        // Sub-document write: never clobbers fields changed elsewhere
        // (premium/badges) while we held a possibly-stale copy of the doc.
        const specs: MutateInSpec[] = [
            MutateInSpec.increment('stats.messagesSent', 1),
            MutateInSpec.replace('relationship', rel),
        ];
        if (memories) specs.push(MutateInSpec.replace('memories', memories));

        try {
            await this.collection.mutateIn(hashKey(userId), specs);
        } catch (err) {
            if (!(err instanceof PathNotFoundError)) throw err;
            // update() refreshes the cache with this exact patch — no extra patching.
            await this.update(
                userId,
                {
                    relationship: rel,
                    ...(memories ? { memories } : {}),
                    stats: { ..._base.stats, messagesSent: _base.stats.messagesSent + 1 },
                },
                _base,
            );
            return;
        }

        userCachePatch(userId, (data) => {
            data.stats.messagesSent += 1;
            data.relationship = { ...rel };
            if (memories) data.memories = [...memories];
        });
    }

    async bumpMessages(userId: string, base: UserData, memories?: string[]): Promise<void> {
        const specs: MutateInSpec[] = [MutateInSpec.increment('stats.messagesSent', 1)];
        if (memories) specs.push(MutateInSpec.replace('memories', memories));

        try {
            await this.collection.mutateIn(hashKey(userId), specs);
        } catch (err) {
            if (!(err instanceof PathNotFoundError)) throw err;
            // update() refreshes the cache with this exact patch — no extra patching.
            await this.update(
                userId,
                {
                    ...(memories ? { memories } : {}),
                    stats: { ...base.stats, messagesSent: base.stats.messagesSent + 1 },
                },
                base,
            );
            return;
        }

        userCachePatch(userId, (data) => {
            data.stats.messagesSent += 1;
            if (memories) data.memories = [...memories];
        });
    }

    async addBadge(userId: string, badge: string): Promise<void> {
        const user = await this.ensure(userId);
        if (!user.badges.includes(badge)) {
            await this.update(userId, { badges: [...user.badges, badge] });
        }
    }

    async removeBadge(userId: string, badge: string): Promise<void> {
        const user = await this.ensure(userId);
        await this.update(userId, { badges: user.badges.filter(b => b !== badge) });
    }
}

class GuildsModel {
    constructor(private collection: Collection) {}

    async get(guildId: string): Promise<GuildData | null> {
        try {
            const doc = await this.collection.get(hashKey(guildId));
            return doc.content as GuildData;
        } catch (err) {
            if (err instanceof DocumentNotFoundError) return null;
            throw err;
        }
    }

    async set(guildId: string, data: GuildData): Promise<void> {
        await this.collection.upsert(hashKey(guildId), data);
    }

    async remove(guildId: string): Promise<void> {
        await this.collection.remove(hashKey(guildId));
    }

    async setChannel(guildId: string, channelId: string, persona: string): Promise<void> {
        const guild = await this.get(guildId);
        const channels = guild?.channels ?? {};
        const hashed = hashKey(channelId);
        channels[hashed] = { persona: encrypt(persona), channelId: encrypt(channelId) };
        await this.set(guildId, { channels, createdAt: guild?.createdAt ?? Date.now() });
    }

    async removeChannel(guildId: string, channelId: string): Promise<void> {
        const guild = await this.get(guildId);
        if (!guild) return;
        const hashed = hashKey(channelId);
        delete guild.channels[hashed];
        await this.set(guildId, guild);
    }

    async getChannel(guildId: string, channelId: string): Promise<string | null> {
        const guild = await this.get(guildId);
        if (!guild) return null;
        const hashed = hashKey(channelId);
        const config = guild.channels[hashed];
        if (!config) return null;
        return decrypt(config.persona);
    }
}

let Users: UsersModel;
let Guilds: GuildsModel;

async function initDB(): Promise<void> {
    const collections = await CouchbaseClient.init();

    Users = new UsersModel(collections.users);
    Guilds = new GuildsModel(collections.guilds);

    console.log('[db] ✅ Models ready');
}

export { initDB, Users, Guilds };