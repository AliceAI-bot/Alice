import { DocumentNotFoundError, PathNotFoundError, Collection, MutateInSpec } from 'couchbase';
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
        try {
            const doc = await this.collection.get(hashKey(userId));
            const data = doc.content as any;

            return {
                ...data,
                byokKey: data.byokKey ? decrypt(data.byokKey) : null,
                blacklistReason: data.blacklistReason ? decrypt(data.blacklistReason) : null,
            };
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

        await this.collection.insert(hashKey(userId), fresh);
        return fresh;
    }

    async update(userId: string, patch: Partial<UserData>, base?: UserData): Promise<void> {
        const existing = base ?? (await this.get(userId));
        if (!existing) throw new Error('User not found');

        await this.collection.upsert(hashKey(userId), this.serialize({ ...existing, ...patch }));
    }

    async hasAcceptedTos(userId: string): Promise<boolean> {
        return (await this.get(userId)) !== null;
    }

    async blacklist(userId: string, reason = 'Unknown'): Promise<void> {
        await this.update(userId, { blacklisted: true, blacklistReason: reason });
    }

    async unblacklist(userId: string): Promise<void> {
        await this.update(userId, { blacklisted: false, blacklistReason: null });
    }

    async isBlacklisted(userId: string): Promise<boolean> {
        const user = await this.get(userId);
        return user?.blacklisted ?? false;
    }

    async getBlacklistReason(userId: string): Promise<string | null> {
        const user = await this.get(userId);
        return user?.blacklistReason ?? null;
    }

    async saveInteraction(
        userId: string,
        base: UserData,
        rel: RelationshipState,
        memories?: string[],
    ): Promise<void> {
        await this.update(
            userId,
            {
                relationship: rel,
                ...(memories ? { memories } : {}),
                stats: { ...base.stats, messagesSent: base.stats.messagesSent + 1 },
            },
            base,
        );
    }

    async bumpMessages(userId: string, base: UserData, memories?: string[]): Promise<void> {
        const specs: MutateInSpec[] = [MutateInSpec.increment('stats.messagesSent', 1)];
        if (memories) specs.push(MutateInSpec.replace('memories', memories));

        try {
            await this.collection.mutateIn(hashKey(userId), specs);
        } catch (err) {
            if (!(err instanceof PathNotFoundError)) throw err;
            await this.update(
                userId,
                {
                    ...(memories ? { memories } : {}),
                    stats: { ...base.stats, messagesSent: base.stats.messagesSent + 1 },
                },
                base,
            );
        }
    }

    async addMemory(userId: string, memory: string, maxSlots: number): Promise<void> {
        const user = await this.ensure(userId);
        const memories = [...user.memories, memory].slice(-maxSlots);
        await this.update(userId, { memories });
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