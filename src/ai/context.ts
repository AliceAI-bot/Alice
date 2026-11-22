import fs from 'fs';
import path from 'path';
import type { SessionMessage, SessionSummary } from '../db/redisStore.js';
import { buildMoodLine, buildRelationshipContext, formatTimeGap, formatTokyoNow } from '../utils/relationship.js';
import type { RelationshipStatus } from '../utils/relationship.js';

const LONG_GAP_MS = 3 * 24 * 60 * 60 * 1000;
const PRESET_PATH = 'src/ai/instructions/preset.txt';
const PERSONA_DIR = 'src/ai/instructions/Persona';
const TOOLS_PATH = 'src/ai/instructions/tools.txt';

const TURN_CONTRACT = `
# Output Contract
Respond with exactly one JSON object, nothing else:
{"message": string, "emotion": string, "relationship_delta": integer, "memory_action": object|null, "tool_call": object|null}

- message: reply as Alice. Empty ONLY when tool_call is set. Don't just echo.
- Agency: outright refuse per preset; ignore_user per Tools (last resort only).
- Emoji: per Reply Style (at most one [tag]).
- Voice lock: MUST start lowercase (sentence-initial proper nouns keep capitals). Drop "?" unless the question needs it. No "!" ever.
- memory_action: remember only durable user facts (esp. explicit "remember X"), forget only on explicit drop, else null.
- relationship_delta/emotion: -3..+3 intent shift (0 = smalltalk), emotion from enum to match reply.
- tool_call: {"name":..., "query":..., "target":..., "message":..., "action":..., "emoji":...} with ONLY that tool's fields, INSTEAD of replying; null when done/unneeded.`;

function loadPromptFile(relativePath: string): string {
    try {
        return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
    } catch {
        return '';
    }
}

const staticPromptCache = new Map<string, string>();

/** Preset + persona + tools + contract, joined once per persona and cached. */
export function buildStaticSystemPrompt(personaName: string): string {
    const cached = staticPromptCache.get(personaName);
    if (cached !== undefined) return cached;

    const preset = loadPromptFile(PRESET_PATH);
    const persona = loadPromptFile(path.join(PERSONA_DIR, `${personaName}.txt`));
    const tools = loadPromptFile(TOOLS_PATH);
    if (!persona) {
        console.warn(`[ai] Persona "${personaName}" missing or empty — replying without character content.`);
    }

    const prompt = [preset, '# Persona', persona, tools, TURN_CONTRACT]
        .filter((part) => part.trim() !== '')
        .join('\n\n');
    staticPromptCache.set(personaName, prompt);
    return prompt;
}

/** Strip a leading bot mention so history stays clean (`<@id> hi` -> `hi`). */
export function stripBotMention(raw: string, botId?: string | null): string {
    // Fall back to any mention-like token when the bot id is unknown.
    const mention = botId ? `<@!?${botId}>` : '<@!?\\d+>';
    return raw.replace(new RegExp(`^\\s*${mention}\\s*`), '').trim();
}

interface ContextOptions {
    userName: string;
    status: RelationshipStatus;
    affection: number;
    lastEmotion: string | null;
    lastInteractionAt: number | null;
    now: number;
    memories: string[];
    summary: SessionSummary | null;
    styleHint: string;
    statusJustChanged: boolean;
}

/** Relationship, time, memory and summary blocks assembled into the live system prompt. */
export function buildContextSystemPrompt(opts: ContextOptions): string {
    const relationshipLine = buildRelationshipContext(opts.status).replace('{user}', opts.userName);
    const nowLine = `${formatTokyoNow(new Date(opts.now))}.`;
    const gapMs = opts.lastInteractionAt == null ? null : opts.now - opts.lastInteractionAt;
    const gapLine =
        gapMs === null
            ? `First meeting ${opts.userName}.`
            : `Last: ${formatTimeGap(gapMs)}.${gapMs > LONG_GAP_MS ? ' Long time.' : ''}`;
    const moodLine = buildMoodLine(opts.lastEmotion, opts.lastInteractionAt, opts.now);
    const changedLine = opts.statusJustChanged ? 'Bond just shifted — show it, never announce it.' : '';
    const memoryBlock = opts.memories.length
        ? `# Memories ${opts.userName}\n${opts.memories.map((m) => `- ${m}`).join('\n')}\n(use casually; quote only if asked)`
        : '';
    const summaryBlock = opts.summary?.text
        ? `# Earlier\n${opts.summary.text}${
              opts.summary.openLoops.length
                  ? `\nLoops (follow up sometime, don't force):\n${opts.summary.openLoops.map((l) => `- ${l}`).join('\n')}`
                  : ''
          }`
        : '';

    return ['# Current Context', nowLine, gapLine, relationshipLine, moodLine, changedLine, opts.styleHint, '', memoryBlock, summaryBlock]
        .filter((part) => part !== '')
        .join('\n');
}

/** Mirroring hint: how the user tends to text (observation only, no instruction). */
export function buildStyleHint(session: SessionMessage[], userId: string): string {
    const mine = session.filter((m) => m.role === 'user' && m.authorId === userId).slice(-6);
    if (mine.length < 2) return '';
    const avg = mine.reduce((a, m) => a + m.content.length, 0) / mine.length;
    if (avg < 25) return 'They text super short.';
    if (avg < 80) return 'They text casual-medium.';
    return 'They write longer messages.';
}
