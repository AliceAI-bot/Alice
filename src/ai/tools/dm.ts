import { Users } from '../../db/database.js';
import { applyEmojis } from '../../utils/emojis.js';
import type { ToolContext } from '../../types/ai.js';

export const DM_TOOL = 'dm_user';

const TARGET_RE = /<@!?(\d+)>/;

function extractId(target: unknown): string | null {
    if (typeof target !== 'string') return null;
    const match = target.match(TARGET_RE);
    if (match?.[1]) return match[1];
    if (/^\d{10,25}$/.test(target.trim())) return target.trim();
    return null;
}

function resolveTargetId(ctx: ToolContext, args: Record<string, unknown>): string | null {
    const fromArg = extractId(args.target);
    if (fromArg) return fromArg;

    const mentioned = ctx.message.mentions.users.filter((u) => u.id !== ctx.requesterId && !u.bot);
    const first = mentioned.first();
    if (first) return first.id;

    return null;
}

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

    const targetId = resolveTargetId(ctx, args) ?? ctx.requesterId;

    if (targetId === ctx.requesterId) {
        return sendDm(ctx, ctx.requesterId, content);
    }

    const targetUser = await Users.get(targetId);
    if (!targetUser) {
        return "That user hasn't used Alice before, so she can't DM them.";
    }

    return sendDm(ctx, targetId, content);
}