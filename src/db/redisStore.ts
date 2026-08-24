import redisClient from '../integrations/redis.js';
import { normalizeRelationship } from '../utils/relationship.js';
import type { RelationshipState } from '../utils/relationship.js';

const SESSION_TTL_SECONDS = 3 * 60 * 60;
const SESSION_MAX_MESSAGES = 30;

const USER_TTL_SECONDS = 24 * 60 * 60;
export const VOTE_FRESH_MS = 60 * 60 * 1000;

export interface SessionMessage {
    role?: 'user' | 'assistant';
    authorId: string;
    username: string;
    content: string;
    ts: number;
}

export function sessionKey(guildId: string | null, channelId: string): string {
    return guildId ? `session:${guildId}:${channelId}` : `session:dm:${channelId}`;
}

export async function getSession(key: string): Promise<SessionMessage[]> {
    const raw = await redisClient.lRange(key, 0, -1);
    const messages: SessionMessage[] = [];

    for (const line of raw) {
        try {
            messages.push(JSON.parse(line) as SessionMessage);
        } catch {
        }
    }

    return messages;
}

export async function resetSession(key: string): Promise<void> {
    await redisClient.del(key);
}

export interface UserUsageState {
    day: string;
    count: number;
}

export interface UserVoteState {
    voted: boolean;
    checkedAt: number;
}

export interface UserState {
    rel: RelationshipState | null;
    usage: UserUsageState;
    vote: UserVoteState | null;
    ignoredUntil: number | null;
}

type UserBlob = Pick<UserState, 'rel' | 'usage' | 'vote'>;

function userKey(userId: string): string {
    return `user:${userId}`;
}

export function usageToday(): string {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate(),
    ).padStart(2, '0')}`;
    return date;
}

export function emptyUserState(): UserState {
    return { rel: null, usage: { day: usageToday(), count: 0 }, vote: null, ignoredUntil: null };
}

function normalizeUserBlob(raw: unknown): UserBlob {
    if (!raw || typeof raw !== 'object') return emptyUserState();

    const r = raw as Record<string, unknown>;

    const rel = r.rel ? normalizeRelationship(r.rel) : null;

    const usageRaw = (r.usage ?? {}) as Record<string, unknown>;
    const usage: UserUsageState = {
        day: typeof usageRaw.day === 'string' ? usageRaw.day : usageToday(),
        count:
            typeof usageRaw.count === 'number' && Number.isFinite(usageRaw.count)
                ? Math.max(0, Math.trunc(usageRaw.count))
                : 0,
    };

    let vote: UserVoteState | null = null;
    if (r.vote && typeof r.vote === 'object') {
        const v = r.vote as Record<string, unknown>;
        if (typeof v.voted === 'boolean' && typeof v.checkedAt === 'number') {
            vote = { voted: v.voted, checkedAt: v.checkedAt };
        }
    }

    return { rel, usage, vote };
}

function parseUserBlob(raw: string | null): UserBlob {
    if (!raw) return emptyUserState();

    try {
        return normalizeUserBlob(JSON.parse(raw));
    } catch {
        return emptyUserState();
    }
}

export async function getUserState(userId: string): Promise<UserState> {
    const [raw, ignoreRaw] = await Promise.all([
        redisClient.get(userKey(userId)),
        redisClient.get(ignoredKey(userId)),
    ]);

    const ignoredUntil = ignoreRaw === null ? null : Number(ignoreRaw);

    return {
        ...parseUserBlob(raw),
        ignoredUntil: ignoredUntil !== null && Number.isFinite(ignoredUntil) ? ignoredUntil : null,
    };
}

export async function saveUserState(userId: string, state: UserState): Promise<void> {
    await redisClient.set(
        userKey(userId),
        JSON.stringify({ rel: state.rel, usage: state.usage, vote: state.vote }),
        { EX: USER_TTL_SECONDS },
    );
}

export async function persistTurn(
    key: string,
    messages: SessionMessage[],
    userId: string,
    state: Pick<UserState, 'rel' | 'usage' | 'vote'>,
): Promise<void> {
    const tx = redisClient.multi();
    for (const msg of messages) tx.rPush(key, JSON.stringify(msg));
    tx.lTrim(key, -SESSION_MAX_MESSAGES, -1);
    tx.expire(key, SESSION_TTL_SECONDS);
    tx.set(userKey(userId), JSON.stringify(state), { EX: USER_TTL_SECONDS });
    await tx.exec();
}

export async function getUsage(userId: string): Promise<number> {
    const state = await getUserState(userId);
    return state.usage.day === usageToday() ? state.usage.count : 0;
}

const IGNORED_PREFIX = 'ignored:';

function ignoredKey(userId: string): string {
    return `${IGNORED_PREFIX}${userId}`;
}

export async function setIgnored(userId: string, durationMs: number): Promise<void> {
    await redisClient.set(ignoredKey(userId), String(Date.now() + durationMs), { PX: durationMs });
}

export async function clearIgnored(userId: string): Promise<void> {
    await redisClient.del(ignoredKey(userId));
}
