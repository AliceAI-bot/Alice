import { DocumentExistsError, DocumentNotFoundError, PathNotFoundError, Collection, MutateInSpec } from 'couchbase';
import CouchbaseClient from '../integrations/couchbase.js';
import { encrypt, decrypt, hashKey } from '../integrations/crypto.js';
import { createRelationship } from '../utils/relationship.js';
import type { RelationshipState } from '../utils/relationship.js';

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

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

/** Bounded read-through cache with TTL + LRU eviction. */
function createTtlCache<T>(ttlMs: number, max: number, clone: (data: T) => T) {
    const store = new Map<string, CacheEntry<T>>();

    return {
        get(key: string): T | null {
            const entry = store.get(key);
            if (!entry) return null;
            if (entry.expiresAt <= Date.now()) {
                store.delete(key);
                return null;
            }
            // Refresh LRU position.
            store.delete(key);
            store.set(key, entry);
            return clone(entry.data);
        },
        set(key: string, data: T): void {
            store.delete(key);
            store.set(key, { data: clone(data), expiresAt: Date.now() + ttlMs });
            if (store.size > max) {
                const oldest = store.keys().next().value;
                if (oldest !== undefined) store.delete(oldest);
            }
        },
        patch(key: string, apply: (data: T) => void): void {
            const entry = store.get(key);
            if (!entry || entry.expiresAt <= Date.now()) return;
            apply(entry.data);
        },
        delete(key: string): void {
            store.delete(key);
        },
    };
}

function cloneUser(data: UserData): UserData {
    return {
        ...data,
        stats: { ...data.stats },
        badges: [...data.badges],
        relationship: { ...data.relationship },
        memories: [...data.memories],
    };
}

function cloneGuild(data: GuildData): GuildData {
    return { ...data, channels: { ...data.channels } };
}

// In-process read-through caches. Every mutating method invalidates/updates
// them, so same-process writes are always coherent; writes from other
// processes become visible within the cache TTL.
const USER_CACHE_TTL_MS = 3 * 60 * 1000;
const USER_CACHE_MAX = 2000;
const userCache = createTtlCache(USER_CACHE_TTL_MS, USER_CACHE_MAX, cloneUser);

// Guild configs change rarely but are read every guild turn — brief cache.
const GUILD_CACHE_TTL_MS = 60 * 1000;
const GUILD_CACHE_MAX = 5000;
const guildCache = createTtlCache(GUILD_CACHE_TTL_MS, GUILD_CACHE_MAX, cloneGuild);

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
        const cached = userCache.get(userId);
        if (cached) return cached;

        try {
            const doc = await this.collection.get(hashKey(userId));
            const raw = doc.content as UserData;

            const data: UserData = {
                ...raw,
                byokKey: raw.byokKey ? decrypt(raw.byokKey) : null,
                blacklistReason: raw.blacklistReason ? decrypt(raw.blacklistReason) : null,
            };
            userCache.set(userId, data);
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
        userCache.set(userId, fresh);
        return cloneUser(fresh);
    }

    async update(userId: string, patch: Partial<UserData>, base?: UserData): Promise<void> {
        const existing = base ?? (await this.get(userId));
        if (!existing) throw new Error('User not found');

        await this.collection.upsert(hashKey(userId), this.serialize({ ...existing, ...patch }));
        userCache.set(userId, { ...existing, ...patch });
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

    /**
     * Sub-document write: never clobbers fields changed elsewhere (premium/
     * badges) while we held a possibly-stale copy of the doc.
     */
    async recordMessage(
        userId: string,
        base: UserData,
        memories: string[] | undefined,
        rel?: RelationshipState,
    ): Promise<void> {
        const specs: MutateInSpec[] = [MutateInSpec.increment('stats.messagesSent', 1)];
        if (rel) specs.push(MutateInSpec.replace('relationship', rel));
        if (memories) specs.push(MutateInSpec.replace('memories', memories));

        try {
            await this.collection.mutateIn(hashKey(userId), specs);
        } catch (err) {
            if (!(err instanceof PathNotFoundError)) throw err;
            // update() refreshes the cache with this exact patch — no extra patching.
            await this.update(
                userId,
                {
                    ...(rel ? { relationship: rel } : {}),
                    ...(memories ? { memories } : {}),
                    stats: { ...base.stats, messagesSent: base.stats.messagesSent + 1 },
                },
                base,
            );
            return;
        }

        userCache.patch(userId, (data) => {
            data.stats.messagesSent += 1;
            if (rel) data.relationship = { ...rel };
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
        const cached = guildCache.get(guildId);
        if (cached) return cached;

        try {
            const doc = await this.collection.get(hashKey(guildId));
            const data = doc.content as GuildData;
            guildCache.set(guildId, data);
            return cloneGuild(data);
        } catch (err) {
            if (err instanceof DocumentNotFoundError) return null;
            throw err;
        }
    }

    async set(guildId: string, data: GuildData): Promise<void> {
        await this.collection.upsert(hashKey(guildId), data);
        guildCache.set(guildId, data);
    }

    async remove(guildId: string): Promise<void> {
        await this.collection.remove(hashKey(guildId));
        guildCache.delete(guildId);
    }

    async setChannel(guildId: string, channelId: string, persona: string): Promise<void> {
        const guild = await this.get(guildId);
        const channels = guild?.channels ?? {};
        const hashed = hashKey(channelId);
        channels[hashed] = { persona: encrypt(persona) };
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
