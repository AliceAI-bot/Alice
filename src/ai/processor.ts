// i hate this file, seriosly
import fs from 'fs';
import path from 'path';
import type { Message } from 'discord.js';
import { Users } from '../db/database.js';
import {
    getSession,
    getUserState,
    persistTurn,
    sessionKey,
    usageToday,
    VOTE_FRESH_MS,
} from '../db/redisStore.js';
import { RELATIONSHIP_CONFIG } from '../config/relationshipConfig.js';
import { applyEmojis } from '../utils/emojis.js';
import {
    applyMonthlyDecay,
    buildRelationshipContext,
    clamp,
    deriveStatus,
    normalizeRelationship,
} from '../utils/relationship.js';
import type { RelationshipState, RelationshipStatus } from '../utils/relationship.js';
import {
    AiError,
    AiMessage,
    AiToolExecutor,
    ALICE_TURN_SCHEMA,
    parseAliceTurn,
    toolRequestArgs,
    ToolContext,
} from '../types/ai.js';
import type { AliceTurn } from '../types/ai.js';
import { chat } from '../integrations/google.js';
import { refreshVote } from '../utils/voterCheck.js';
import type { UserVoteState } from '../db/redisStore.js';
import type { ChatImage } from '../integrations/google.js';
import { DM_TOOL, executeDm } from './tools/dm.js';
import { IGNORE_TOOL, executeIgnore } from './tools/ignore.js';
import { WEB_SEARCH_TOOL, executeWebSearch } from './tools/webSearch.js';

export interface ProcessResult {
    content: string;
}

export interface ProcessOptions {
    onThinking?: () => () => void;
}

const PRESET_PATH = 'src/ai/instructions/preset.txt';
const PERSONA_DIR = 'src/ai/instructions/Persona';
const TOOLS_PATH = 'src/ai/instructions/tools.txt';

const TURN_CONTRACT = `
# Output Contract
Respond with exactly one JSON object and nothing else:
{"message": string, "emotion": string, "relationship_delta": integer, "memory_action": object|null, "tool_call": object|null}

- message: your reply as Alice, in your own voice. Empty string ONLY when tool_call is set.
- emotion: how you feel right now — one of: neutral, happy, affectionate, flirty, sad, annoyed, angry, surprised, worried.
- relationship_delta: -3..+3 for how strongly this interaction moves your bond (+3 major warmth or joy, -3 real hurt or betrayal, 0 for neutral smalltalk). Judge intent, not just words.
- memory_action: set to {"action":"remember","text":"..."} to store one durable fact about the user worth recalling later (preferences, life events, names; one sentence, never secrets), or {"action":"forget","text":"..."} with the exact existing memory to drop. null otherwise.
- tool_call: set to {"name":..., "query":..., "target":..., "message":..., "action":...} to run a tool INSTEAD of replying (fields per the Tools section; include ONLY what that tool needs); null once you have its result or don't need one.`;

const MEMORY_MAX_CHARS = 160;
const MEMORY_MAX_SLOTS = 30;

const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const promptCache = new Map<string, string>();

function loadPromptFile(relativePath: string): string {
    const cached = promptCache.get(relativePath);
    if (cached !== undefined) return cached;

    let content = '';
    try {
        content = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
    } catch {
    }

    promptCache.set(relativePath, content);
    return content;
}

const staticPromptCache = new Map<string, string>();

function buildStaticSystemPrompt(personaName: string): string {
    const cached = staticPromptCache.get(personaName);
    if (cached !== undefined) return cached;

    const preset = loadPromptFile(PRESET_PATH);
    const persona = loadPromptFile(path.join(PERSONA_DIR, `${personaName}.txt`));
    const tools = loadPromptFile(TOOLS_PATH);

    const prompt = [preset, '# Persona', persona, tools, TURN_CONTRACT]
        .filter((part) => part.trim() !== '')
        .join('\n\n');
    staticPromptCache.set(personaName, prompt);
    return prompt;
}

function buildContextSystemPrompt(opts: {
    userName: string;
    status: RelationshipStatus;
    lastEmotion: string | null;
    memories: string[];
}): string {
    const relationshipLine = buildRelationshipContext(opts.status).replace('{user}', opts.userName);
    const moodLine = opts.lastEmotion ? `Your mood right now: ${opts.lastEmotion}.` : '';
    const memoryBlock = opts.memories.length
        ? `# Memories about ${opts.userName}\n${opts.memories.map((m) => `- ${m}`).join('\n')}`
        : '';

    return ['# Current Context', relationshipLine, moodLine, '', memoryBlock]
        .filter((part) => part !== '')
        .join('\n');
}

const MAX_SANE_REPLY_LENGTH = 1800;

function busyTurn(): AliceTurn {
    return {
        message: "Mm, sorry—my head's spinning a little right now. Give me a moment and say that again?",
        emotion: 'worried',
        relationshipDelta: 0,
        memoryAction: null,
        toolCall: null,
    };
}

async function askAlice(
    system: string,
    messages: AiMessage[],
    apiKey?: string,
    images?: ChatImage[],
): Promise<AliceTurn> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const { text } = await chat({
            system,
            messages,
            schema: ALICE_TURN_SCHEMA,
            ...(apiKey ? { apiKey } : {}),
            ...(images?.length ? { images } : {}),
        });
        const turn = parseAliceTurn(text);
        if (turn) return turn;
    }
    throw new AiError('Model produced unusable structured output.');
}

const MAX_TOOL_ROUNDS = 2;

async function converse(
    system: string,
    messages: AiMessage[],
    executor: AiToolExecutor,
    apiKey?: string,
    images?: ChatImage[],
): Promise<AliceTurn> {
    for (let round = 0; ; round++) {
        const turn = await askAlice(system, messages, apiKey, images);

        if (!turn.toolCall) return turn;

        if (round >= MAX_TOOL_ROUNDS) {
            console.warn('[ai] Tool budget exhausted; requesting direct reply.');
            messages.push({
                role: 'user',
                content: '[system] Tools are unavailable right now. Respond NOW in message without setting tool_call.',
            });
            const finalTurn = await askAlice(system, messages, apiKey, images);
            return { ...finalTurn, toolCall: null };
        }

        let observation: unknown;
        try {
            observation = await executor(turn.toolCall.name, toolRequestArgs(turn.toolCall));
        } catch (err) {
            observation = { error: err instanceof Error ? err.message : String(err) };
        }
        const resultText =
            typeof observation === 'string' ? observation : JSON.stringify(observation);

        messages.push({
            role: 'assistant',
            content: `tool_call: ${turn.toolCall.name}(${JSON.stringify(toolRequestArgs(turn.toolCall))})`,
        });
        messages.push({
            role: 'user',
            content: `[${turn.toolCall.name} result]: ${resultText}\nContinue with the Output Contract.`,
        });
    }
}

async function generate(
    system: string,
    messages: AiMessage[],
    executor: AiToolExecutor,
    byokKey?: string,
    images?: ChatImage[],
): Promise<{ reply: string; turn: AliceTurn; degraded: boolean }> {
    try {
        const turn = await converse(system, messages, executor, byokKey, images);

        const reply = turn.message.trim();
        if (!reply || reply.length > MAX_SANE_REPLY_LENGTH) {
            console.warn('[ai] Unusable reply length, returning busy fallback.');
            return { reply: busyTurn().message, turn: busyTurn(), degraded: true };
        }
        return { reply, turn, degraded: false };
    } catch (error) {
        console.error('Generation failed:', error);
        const busy = busyTurn();
        return { reply: busy.message, turn: busy, degraded: true };
    }
}

const userLocks = new Map<string, Promise<unknown>>();

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = userLocks.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const sentinel = run.then(
        () => undefined,
        () => undefined,
    );
    userLocks.set(userId, sentinel);
    void sentinel.then(() => {
        if (userLocks.get(userId) === sentinel) userLocks.delete(userId);
    });
    return run;
}

export async function processMessage(
    message: Message,
    persona: string | null = null,
    opts: ProcessOptions = {},
): Promise<ProcessResult | null> {
    const author = message.author;
    if (!author || author.bot) return null;

    return withUserLock(author.id, () => handleProcess(message, persona, opts));
}

async function collectImages(message: Message): Promise<ChatImage[]> {
    const eligible: Array<{ mimeType: string; url: string }> = [];

    for (const attachment of message.attachments.values()) {
        if (eligible.length >= MAX_IMAGES) break;

        const type = attachment.contentType ?? '';
        if (!type.startsWith('image/') || attachment.size > MAX_IMAGE_BYTES) continue;

        eligible.push({ mimeType: type, url: attachment.url });
    }

    const results = await Promise.allSettled(
        eligible.map(async ({ mimeType, url }) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);

            const buffer = Buffer.from(await res.arrayBuffer());
            return { mimeType, data: buffer.toString('base64') };
        }),
    );

    return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

async function handleProcess(
    message: Message,
    persona: string | null,
    opts: ProcessOptions,
): Promise<ProcessResult | null> {
    const author = message.author!;
    const userId = author.id;
    const now = Date.now();

    const [user, state] = await Promise.all([Users.ensure(userId), getUserState(userId)]);
    if (user.blacklisted) return null;
    if (state.ignoredUntil != null && state.ignoredUntil > now) return null;

    const byokKey = user.byokKey?.startsWith('AIza') ? user.byokKey : undefined;
    const isByok = Boolean(byokKey);

    const content = message.content;

    let rel: RelationshipState;
    let decayed = false;
    if (state.rel) {
        rel = state.rel;
    } else {
        const result = applyMonthlyDecay(normalizeRelationship(user.relationship), now);
        rel = result.rel;
        decayed = result.decayed;
    }

    let voted = false;
    let vote = state.vote;
    let usedToday = 0;
    if (!isByok) {
        usedToday = state.usage.day === usageToday() ? state.usage.count : 0;

        if (vote && now - vote.checkedAt < VOTE_FRESH_MS) {
            voted = vote.voted;
        } else {
            const fresh = await refreshVote(userId);
            if (fresh === null) {
                // top.gg unreachable: keep last known status, don't extend its freshness.
                voted = vote?.voted ?? false;
            } else {
                voted = fresh;
                vote = { voted, checkedAt: now } satisfies UserVoteState;
            }
        }

        const base = user.tier === 'premium' ? RELATIONSHIP_CONFIG.usage.premium : RELATIONSHIP_CONFIG.usage.free;
        const quota = base + (voted ? RELATIONSHIP_CONFIG.usage.voterBonus : 0);

        if (usedToday >= quota) {
            return {
                content: `You've used up your daily messages (${quota}). Voting for Alice on Top.gg grants +${RELATIONSHIP_CONFIG.usage.voterBonus} bonus messages!`,
            };
        }
    }

    if (!message.channel) return null;
    const isDM = message.channel.isDMBased();
    const key = sessionKey(isDM ? null : message.guildId, message.channelId);
    const [session, images] = await Promise.all([
        getSession(key),
        message.attachments.size ? collectImages(message) : Promise.resolve([]),
    ]);

    const contextPrompt = buildContextSystemPrompt({
        userName: author.username,
        status: rel.status,
        lastEmotion: rel.lastEmotion,
        memories: user.memories,
    });

    const system = [buildStaticSystemPrompt(persona ?? 'default'), contextPrompt]
        .filter((part) => part !== '')
        .join('\n\n');

    const messages: AiMessage[] = session.map<AiMessage>((m) =>
        m.role === 'assistant'
            ? { role: 'assistant', content: m.content }
            : { role: 'user', content: `${m.username}: ${m.content}` },
    );
    messages.push({ role: 'user', content });

    const executor: AiToolExecutor = (name, args) => {
        const ctx: ToolContext = { message, requesterId: userId };
        if (name === DM_TOOL) return executeDm(ctx, args);
        if (name === IGNORE_TOOL) return executeIgnore(ctx, args);
        if (name === WEB_SEARCH_TOOL) return executeWebSearch(args.query, byokKey);
        throw new Error(`Unknown tool: ${name}`);
    };

    let stopThinking: (() => void) | undefined;
    let reply: string;
    let turn: AliceTurn;
    let degraded: boolean;
    try {
        stopThinking = opts.onThinking?.();
        ({ reply, turn, degraded } = await generate(system, messages, executor, byokKey, images));
    } finally {
        stopThinking?.();
    }

    if (degraded) return { content: applyEmojis(reply) };

    const delta = clamp(-3, 3, turn.relationshipDelta);
    const affection = clamp(
        RELATIONSHIP_CONFIG.scoring.floor,
        RELATIONSHIP_CONFIG.scoring.ceiling,
        rel.affection + delta,
    );
    const status = deriveStatus(affection);
    const statusChanged = status !== rel.status;

    rel = {
        ...rel,
        affection,
        status,
        sinceAt: statusChanged ? (status === 'lovers' ? now : null) : rel.sinceAt,
        lastEmotion: turn.emotion,
        lastInteractionAt: now,
    };

    let memories = user.memories;
    if (turn.memoryAction) {
        const text = turn.memoryAction.text.slice(0, MEMORY_MAX_CHARS);
        memories =
            turn.memoryAction.action === 'remember'
                ? [...memories.filter((m) => m !== text), text].slice(-MEMORY_MAX_SLOTS)
                : memories.filter((m) => m.toLowerCase() !== text.toLowerCase());
    }
    const relationshipChanged = statusChanged || decayed || delta !== 0;
    const memoriesChanged = memories !== user.memories;

    const botUser = message.client.user;
    const writes: Promise<unknown>[] = [
        relationshipChanged
            ? Users.saveInteraction(userId, user, rel, memoriesChanged ? memories : undefined)
            : Users.bumpMessages(userId, user, memoriesChanged ? memories : undefined),
        persistTurn(
            key,
            [
                { role: 'user', authorId: userId, username: author.username, content, ts: now },
                {
                    role: 'assistant',
                    authorId: botUser?.id ?? 'alice',
                    username: botUser?.username ?? 'Alice',
                    content: reply,
                    ts: Date.now(),
                },
            ],
            userId,
            {
                rel,
                usage: isByok
                    ? state.usage
                    : { day: usageToday(), count: usedToday + 1 },
                vote,
            },
        ),
    ];
    await Promise.all(writes);
    return { content: applyEmojis(reply) };
}