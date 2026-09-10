import { Users } from '../../db/database.js';
import { applyEmojis } from '../../utils/emojis.js';
import type { ToolContext } from '../../types/ai.js';
import { resolveToolTargetId } from './target.js';

export const DM_TOOL = 'dm_user';

async function sendDm(ctx: ToolContext, targetId: string, content: string): Promise<string> {
    try {
        const user = await ctx.message.client.users.fetch(targetId);
        await user.send(applyEmojis(content));
        return `DM sent to ${user.username}.`;
    } catch {
        return "Alice couldn't DM that user (their DMs may be closed).";
    }
}

export async function executeDm(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const content = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : '';
    if (!content) return "Alice can't send an empty DM.";

    const targetId = resolveToolTargetId(ctx, args);

    if (targetId === ctx.requesterId) {
        return sendDm(ctx, ctx.requesterId, content);
    }

    const targetUser = await Users.get(targetId);
    if (!targetUser) {
        return "That user hasn't used Alice before, so she can't DM them.";
    }

    return sendDm(ctx, targetId, content);
}