import { Users } from '../db/database.js';
import { clearIgnored, markIgnoreWarned } from '../db/redisStore.js';
import type { UserState } from '../db/redisStore.js';
import { applyEmojis } from '../utils/emojis.js';
import { ThinkingLevel } from '@google/genai';
import { chat } from '../integrations/google.js';
import { parseAliceTurn } from '../types/ai.js';
import type { ProcessResult } from './processor.js';

export type GateCheck =
    | { ok: true }
    | { ok: false; /** null = silently stop (blacklisted), non-null = send this reply first */ reply: ProcessResult | null };

/** ToS acceptance + blacklist walls for message processing. */
export async function checkMessageAccess(userId: string): Promise<GateCheck> {
    try {
        const gate = await Users.getGateData(userId);
        if (!gate.accepted) {
            return {
                ok: false,
                reply: {
                    content: applyEmojis('hey, before we talk you gotta accept my tos — run any slash command and hit Agree and Continue first'),
                    emotion: 'neutral',
                    degraded: true,
                    toolsUsed: [],
                },
            };
        }
        if (gate.blacklisted) return { ok: false, reply: null };
    } catch {
        // Gate lookup failed — fall through to normal processing.
    }
    return { ok: true };
}

const IGNORE_APOLOGY_RE =
    /\bsorr(?:y|ies)\b|\bapolog|\bforgive\b|\bmy (?:bad|fault|mistake)\b|\bi (?:was|am) wrong\b|\bwon'?t do it again\b|\bwill stop\b|\bamends?\b/i;

const IGNORE_EVAL_SYSTEM = `You decide if an ignored user genuinely apologized. Respond with exactly one JSON object, nothing else: {"message": string, "emotion": string, "relationship_delta": integer, "memory_action": object|null, "tool_call": object|null}
- Sincere apology/remorse + intent to stop -> tool_call {"name":"ignore_user","action":"unignore"}, message "".
- Anything else ("sorry not sorry", mocking, insults, demands, off-topic, continued creep) -> tool_call null, message "" (host stays silent).
- relationship_delta 0, memory_action null, emotion neutral.`;

const IGNORE_COLD_LINES = [
    'not talking to you till you actually apologize',
    'yeah no, come back when you can apologize properly',
    'ignored till you mean a sorry lol',
] as const;

function ignoreColdLine(): string {
    return IGNORE_COLD_LINES[Math.floor(Math.random() * IGNORE_COLD_LINES.length)]!;
}

/** Single cold line on first message per ignore window, then silence. 1 RTT via SET NX PX. */
async function ignoreColdOrSilent(userId: string, ttlMs: number): Promise<ProcessResult | null> {
    try {
        if (!(await markIgnoreWarned(userId, ttlMs))) return null;
    } catch {
        return null;
    }
    return { content: applyEmojis(ignoreColdLine()), emotion: 'annoyed', degraded: false, toolsUsed: [] };
}

/**
 * Ignored-but-listening: silence by default, but apology-like texts get one
 * minimal LLM eval that can unignore. Non-apologies skip the LLM entirely.
 * `ignoredUntil == null` in the result means "unignored, continue processing";
 * any other value means stop — reply when given, silence otherwise.
 */
export async function resolveIgnoredUser(
    userId: string,
    username: string,
    content: string,
    state: UserState,
    now: number,
): Promise<{ ignoredUntil: number | null; reply: ProcessResult | null }> {
    const ignoredUntil = state.ignoredUntil;
    const remaining = (ignoredUntil ?? now) - now;

    if (!IGNORE_APOLOGY_RE.test(content.slice(0, 500))) {
        return { ignoredUntil, reply: await ignoreColdOrSilent(userId, remaining) };
    }

    try {
        const { text: raw } = await chat({
            system: IGNORE_EVAL_SYSTEM,
            messages: [{ role: 'user', content: `${username}: ${content.slice(0, 500)}` }],
            temperature: 0.3,
            maxTokens: 300,
            thinking: ThinkingLevel.MINIMAL,
        });
        const turn = parseAliceTurn(raw);
        if (turn?.toolCall?.name === 'ignore_user' && turn.toolCall.action === 'unignore') {
            await clearIgnored(userId).catch(() => null);
            return { ignoredUntil: null, reply: null };
        }
    } catch {
        // Eval unavailable — stay silent but keep ignoring.
    }

    return { ignoredUntil, reply: await ignoreColdOrSilent(userId, remaining) };
}
