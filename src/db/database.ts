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

export interface ChannelData {
    isCustom: boolean;
    personaId: string | null;
    customCharId: string | null;
    createdBy: string;
    createdAt: number;
}

export interface CharacterData {
    name: string;
    description: string;
    systemPrompt: string;
    creatorId: string;
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

class ChannelsModel {
    constructor(private collection: Collection) {}

    async get(channelId: string): Promise<ChannelData | null> {
        try {
            const doc = await this.collection.get(hashKey(channelId));
            return doc.content as ChannelData;
        } catch (err) {
            if (err instanceof DocumentNotFoundError) return null;
            throw err;
        }
    }

    async set(channelId: string, data: ChannelData): Promise<void> {
        await this.collection.upsert(hashKey(channelId), data);
    }

    async remove(channelId: string): Promise<void> {
        await this.collection.remove(hashKey(channelId));
    }
}

class CharactersModel {
    constructor(private collection: Collection) {}

    async get(charId: string): Promise<CharacterData | null> {
        try {
            const doc = await this.collection.get(charId);
            const data = doc.content as any;
            return {
                ...data,
                systemPrompt: decrypt(data.systemPrompt),
            };
        } catch (err) {
            if (err instanceof DocumentNotFoundError) return null;
            throw err;
        }
    }

    async create(charId: string, data: Omit<CharacterData, 'createdAt'>): Promise<void> {
        await this.collection.insert(charId, {
            ...data,
            systemPrompt: encrypt(data.systemPrompt),
            createdAt: Date.now(),
        });
    }

    async delete(charId: string): Promise<void> {
        await this.collection.remove(charId);
    }
}

let Users: UsersModel;
let Channels: ChannelsModel;
let Characters: CharactersModel;

async function initDB(): Promise<void> {
    const collections = await CouchbaseClient.init();

    Users = new UsersModel(collections.users);
    Channels = new ChannelsModel(collections.channels);
    Characters = new CharactersModel(collections.characters);

    console.log('[db] ✅ Models ready');
}

export { initDB, Users, Channels, Characters };