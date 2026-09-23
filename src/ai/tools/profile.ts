import { Users } from '../../db/database.js';
import { getSessionSummary, getUserState, sessionKey } from '../../db/redisStore.js';
import { affectionBand, formatTimeGap } from '../../utils/relationship.js';
import type { ToolContext } from '../../types/ai.js';
import { resolveToolTargetId } from './target.js';

export const PROFILE_TOOL = 'get_user_profile';

/**
 * Read-only who-is-this lookup from stores Alice already has (no new infra).
 * Never exposes raw affection numbers or IDs — band words only.
 */
export async function executeProfile(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const targetId = resolveToolTargetId(ctx, args);

    try {
        const [user, state] = await Promise.all([
            Users.get(targetId),
            getUserState(targetId).catch(() => null),
        ]);
        if (!user) return "Alice doesn't know them yet — they haven't talked to her.";

        let username = targetId;
        try {
            username = (await ctx.message.client.users.fetch(targetId)).username;
        } catch {
            // Fall back to the raw id.
        }

        const rel = state?.rel ?? user.relationship;
        const status = (rel?.status ?? 'stranger').replace(/_/g, ' ');
        const band = affectionBand(rel?.affection ?? 0);
        const gap =
            rel?.lastInteractionAt == null
                ? 'never talked'
                : `last talked ${formatTimeGap(Date.now() - rel.lastInteractionAt)}`;
        const memories = (user.memories ?? []).slice(-5);

        // Open loops live per-channel and belong to whoever is in it — only
        // include them when looking up the requester themselves.
        let loops: string[] = [];
        if (targetId === ctx.requesterId) {
            const ch = ctx.message.channel;
            const isDM = typeof ch?.isDMBased === 'function' && ch.isDMBased();
            const key = sessionKey(isDM ? null : (ctx.message.guildId ?? null), ctx.message.channelId);
            const summary = await getSessionSummary(key).catch(() => null);
            loops = (summary?.openLoops ?? []).slice(0, 3);
        }

        const lines = [
            `${username}: ${status}, ${band} bond, ${gap}.`,
            memories.length ? `Known: ${memories.join(' | ').slice(0, 400)}` : 'Known: nothing yet.',
            loops.length ? `Open threads: ${loops.join(' | ').slice(0, 300)}` : '',
        ].filter(Boolean);
        return lines.join('\n').slice(0, 700);
    } catch {
        return 'Profile lookup failed — just reply without it.';
    }
}
