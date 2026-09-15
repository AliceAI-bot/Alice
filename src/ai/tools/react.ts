import type { ToolContext } from '../../types/ai.js';

export const REACT_TOOL = 'react_to_message';

/** Tool-only path (no ambient auto-reactions) — model-chosen reactions stay rare (~3-5%) and safe. */
export const REACT_ALLOWLIST = ['❤️', '😂', '🫂', '😭', '💀'] as const;

export function isAllowedReaction(emoji: unknown): emoji is string {
    return typeof emoji === 'string' && (REACT_ALLOWLIST as readonly string[]).includes(emoji);
}

export async function executeReact(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!isAllowedReaction(args.emoji)) return 'No valid reaction given — skip it and just reply.';
    try {
        await ctx.message.react(args.emoji);
        return `Reacted ${args.emoji} to their message. Now write your text reply.`;
    } catch {
        return "Couldn't react (missing permission) — just reply with text instead.";
    }
}
