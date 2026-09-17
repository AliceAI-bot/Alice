import { clearIgnored, setIgnored } from '../../db/redisStore.js';
import { RELATIONSHIP_CONFIG } from '../../config/relationshipConfig.js';
import type { ToolContext } from '../../types/ai.js';
import { resolveToolTargetId } from './target.js';

export const IGNORE_TOOL = 'ignore_user';

export async function executeIgnore(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const action = args.action === 'unignore' ? 'unignore' : args.action === 'ignore' ? 'ignore' : null;
    if (!action) return "Alice needs an action: ignore or unignore.";

    const targetId = resolveToolTargetId(ctx, args);

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

    const durationMin = Math.round(RELATIONSHIP_CONFIG.ignore.durationMs / 60000);

    return action === 'ignore'
        ? `Alice is ignoring ${name} for the next ${durationMin} minutes.`
        : `Alice is no longer ignoring ${name}.`;
}
