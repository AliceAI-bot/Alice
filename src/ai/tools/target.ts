import type { ToolContext } from '../../types/ai.js';

const TARGET_RE = /<@!?(\d+)>/;
const RAW_ID_RE = /^\d{10,25}$/;

export function extractMentionId(target: unknown): string | null {
    if (typeof target !== 'string') return null;
    const match = target.match(TARGET_RE);
    if (match?.[1]) return match[1];
    if (RAW_ID_RE.test(target.trim())) return target.trim();
    return null;
}

/** Shared mention/ID resolution for dm/ignore/react tools. Falls back to the requester. */
export function resolveToolTargetId(
    ctx: ToolContext,
    args: Record<string, unknown>,
): string {
    const fromArg = extractMentionId(args.target);
    if (fromArg) return fromArg;

    const mentioned = ctx.message.mentions.users.filter((u) => u.id !== ctx.requesterId && !u.bot);
    return mentioned.first()?.id ?? ctx.requesterId;
}
