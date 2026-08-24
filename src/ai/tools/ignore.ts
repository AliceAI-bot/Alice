import { clearIgnored, setIgnored } from '../../db/redisStore.js';
import { RELATIONSHIP_CONFIG } from '../../config/relationshipConfig.js';
import type { ToolContext } from '../../types/ai.js';

export const IGNORE_TOOL = 'ignore_user';

const TARGET_RE = /<@!?(\d+)>/;

function extractId(target: unknown): string | null {
    if (typeof target !== 'string') return null;
    const match = target.match(TARGET_RE);
    if (match?.[1]) return match[1];
    if (/^\d{10,25}$/.test(target.trim())) return target.trim();
    return null;
}

function resolveTargetId(ctx: ToolContext, args: Record<string, unknown>): string {
    const fromArg = extractId(args.target);
    if (fromArg) return fromArg;

    const mentioned = ctx.message.mentions.users.filter((u) => u.id !== ctx.requesterId && !u.bot);
    const first = mentioned.first();
    if (first) return first.id;

    return ctx.requesterId;
}

export async function executeIgnore(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const action = args.action === 'unignore' ? 'unignore' : args.action === 'ignore' ? 'ignore' : null;
    if (!action) return "Alice needs an action: ignore or unignore.";

    const targetId = resolveTargetId(ctx, args);

    if (targetId === ctx.message.client.user?.id) {
        return action === 'ignore' ? "Alice can't ignore herself." : "Alice isn't ignoring herself.";
    }

    if (action === 'ignore') {
        await setIgnored(targetId, RELATIONSHIP_CONFIG.ignore.durationMs);
    } else {
        await clearIgnored(targetId);
    }

    let name = targetId;
    try {
        const user = await ctx.message.client.users.fetch(targetId);
        name = user.username;
    } catch {
    }

    return action === 'ignore'
        ? `Alice is ignoring ${name} for the next 24 hours.`
        : `Alice is no longer ignoring ${name}.`;
}
