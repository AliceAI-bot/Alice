import { DocumentNotFoundError, Collection } from 'couchbase';
import CouchbaseClient from '../integrations/couchbase.js';
import { encrypt, decrypt, hashKey } from '../integrations/crypto.js';

export type Tier = 'free' | 'premium' | 'byok';

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
    relationship: {
        affection: number;
        status: 'stranger' | 'friend' | 'close_friend' | 'bestie' | 'enemy' | 'lovers' | 'married';
    };
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
            relationship: { affection: 0, status: 'stranger' },
            memories: [],
            blacklisted: false,
            blacklistReason: null,
        };

        await this.collection.insert(hashKey(userId), fresh);
        return fresh;
    }

    async update(userId: string, patch: Partial<UserData>): Promise<void> {
        const key = hashKey(userId);
        const existing = await this.get(userId);
        if (!existing) throw new Error('User not found');

        const data = { ...existing, ...patch };
        if (patch.byokKey !== undefined) data.byokKey = patch.byokKey ? encrypt(patch.byokKey) : null;
        if (patch.blacklistReason !== undefined) data.blacklistReason = patch.blacklistReason ? encrypt(patch.blacklistReason) : null;

        await this.collection.upsert(key, data);
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

    async incrementMessages(userId: string): Promise<void> {
        const user = await this.ensure(userId);
        await this.update(userId, {
            stats: { ...user.stats, messagesSent: user.stats.messagesSent + 1 },
        });
    }

    async addMemory(userId: string, memory: string, maxSlots: number): Promise<void> {
        const user = await this.ensure(userId);
        const memories = [...user.memories, memory].slice(-maxSlots);
        await this.update(userId, { memories });
    }

    async updateAffection(userId: string, delta: number): Promise<void> {
        const user = await this.ensure(userId);
        const affection = Math.max(-100, Math.min(100, user.relationship.affection + delta));
        const status = this.affectionToStatus(affection);
        await this.update(userId, { relationship: { affection, status } });
    }

    private affectionToStatus(affection: number): UserData['relationship']['status'] {
        if (affection >= 95) return 'married';
        if (affection >= 80) return 'lovers';
        if (affection >= 65) return 'bestie';
        if (affection >= 50) return 'close_friend';
        if (affection >= 30) return 'friend';
        if (affection >= 0) return 'stranger';
        return 'enemy';
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

    async getAllChannels(guildId: string): Promise<Record<string, string>> {
        const guild = await this.get(guildId);
        if (!guild) return {};
        const decrypted: Record<string, string> = {};
        for (const [, config] of Object.entries(guild.channels)) {
            try {
                const channelId = decrypt(config.channelId);
                const persona = decrypt(config.persona);
                decrypted[channelId] = persona;
            } catch {
                // skip corrupted entries
            }
        }
        return decrypted;
    }

    async clearGuild(guildId: string): Promise<void> {
        await this.remove(guildId);
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