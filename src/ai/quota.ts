import { RELATIONSHIP_CONFIG } from '../config/relationshipConfig.js';
import { saveUserState, usageToday } from '../db/redisStore.js';
import type { UserState, UserVoteState } from '../db/redisStore.js';
import type { UserData } from '../db/database.js';
import type { RelationshipState } from '../utils/relationship.js';
import { refreshVote, voteIsFresh } from '../utils/voterCheck.js';

export interface UsageQuota {
    /**
     * The per-user Gemini API key. Presence means the user is on the `byok`
     * tier => no usage counting, no quota. (Profile advertises "Unlimited"
     * off the same tier flag — keep this the single source of truth.)
     */
    byokKey?: string;
    usedToday: number;
    vote: UserVoteState | null;
    /** Set when the user is over today's quota; never set for BYOK users. */
    blocked: { quota: number; bonus: number } | null;
}

/**
 * Daily-usage + vote state for one turn. Resolves the BYOK tier, refreshes the
 * cached vote when stale, and persists the fresh vote when the user is over
 * quota (so a re-vote isn't re-polled against Top.gg).
 */
export async function resolveUsageQuota(
    userId: string,
    user: UserData,
    state: UserState,
    now: number,
): Promise<UsageQuota> {
    if (user.tier === 'byok' && user.byokKey) {
        return { byokKey: user.byokKey, usedToday: 0, vote: state.vote, blocked: null };
    }

    const usedToday = state.usage.day === usageToday() ? state.usage.count : 0;

    let vote = state.vote;
    let voted = false;
    let voteChanged = false;
    if (vote && voteIsFresh(vote, now)) {
        voted = vote.voted;
    } else {
        const fresh = await refreshVote(userId);
        if (fresh === null) {
            // top.gg unreachable: keep last known status, don't extend its freshness.
            voted = vote?.voted ?? false;
        } else {
            voted = fresh;
            vote = { voted, checkedAt: now } satisfies UserVoteState;
            voteChanged = true;
        }
    }

    const base = user.tier === 'premium' ? RELATIONSHIP_CONFIG.usage.premium : RELATIONSHIP_CONFIG.usage.free;
    const bonus = RELATIONSHIP_CONFIG.usage.voterBonus;
    const quota = base + (voted ? bonus : 0);

    if (usedToday >= quota) {
        if (voteChanged) {
            await saveUserState(userId, { ...state, vote }).catch(() => null);
        }
        return { usedToday, vote, blocked: { quota, bonus } };
    }

    return { usedToday, vote, blocked: null };
}

/** Failures still consume quota — otherwise retries are free and infinite. */
export async function persistDegradedUsage(
    userId: string,
    rel: RelationshipState,
    state: UserState,
    vote: UserVoteState | null,
    usedToday: number,
): Promise<void> {
    await saveUserState(userId, {
        rel,
        usage: { day: usageToday(), count: usedToday + 1 },
        vote,
        ignoredUntil: state.ignoredUntil,
    }).catch(() => null);
}
