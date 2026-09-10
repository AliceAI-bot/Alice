import redisClient from '../integrations/redis.js';
import { normalizeRelationship } from '../utils/relationship.js';
import type { RelationshipState } from '../utils/relationship.js';

const SESSION_TTL_SECONDS = 3 * 60 * 60;
const SESSION_MAX_MESSAGES = 30;
// Only the tail is sent to the model; the head is covered by the rolling summary.
export const SESSION_MODEL_WINDOW = 14;
const SUMMARY_TTL_SECONDS = 3 * 60 * 60;

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
    await redisClient.del([key, summaryKey(key)]);
}

export interface SessionSummary {
    text: string;
    openLoops: string[];
    updatedAt: number;
    coveredUpTo: number;
}

export function summaryKey(sessionKeyValue: string): string {
    return `${sessionKeyValue}:summary`;
}

function normalizeSummary(raw: unknown): SessionSummary | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.text !== 'string' || !r.text.trim()) return null;
    const openLoops = Array.isArray(r.openLoops)
        ? r.openLoops.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).slice(0, 5)
        : [];
    return {
        text: r.text.trim().slice(0, 1200),
        openLoops,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
        coveredUpTo: typeof r.coveredUpTo === 'number' ? r.coveredUpTo : 0,
    };
}

export async function getSessionSummary(key: string): Promise<SessionSummary | null> {
    try {
        const raw = await redisClient.get(summaryKey(key));
        if (!raw) return null;
        return normalizeSummary(JSON.parse(raw));
    } catch {
        return null;
    }
}

export async function saveSessionSummary(key: string, summary: SessionSummary): Promise<void> {
    try {
        await redisClient.set(summaryKey(key), JSON.stringify(summary), { EX: SUMMARY_TTL_SECONDS });
    } catch {
        // Summaries are best-effort; session still works without them.
    }
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
