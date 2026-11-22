import type { Message } from 'discord.js';
import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from 'discord.js';
import { Users } from '../db/database.js';
import {
    getSession,
    getSessionSummary,
    getUserState,
    persistTurn,
    sessionKey,
    usageToday,
    SESSION_MAX_MESSAGES,
    SESSION_MODEL_WINDOW,
} from '../db/redisStore.js';
import type { SessionMessage } from '../db/redisStore.js';
import { RELATIONSHIP_CONFIG } from '../config/relationshipConfig.js';
import { applyEmojis, sanitizeForHistory } from '../utils/emojis.js';
import { applyMonthlyDecay, clamp, deriveStatus, normalizeRelationship } from '../utils/relationship.js';
import type { RelationshipState } from '../utils/relationship.js';
import {
    AiError,
    ALICE_TURN_SCHEMA,
    parseAliceTurn,
    toolRequestArgs,
} from '../types/ai.js';
import type { AiMessage, AiToolExecutor, AliceTurn, ToolContext } from '../types/ai.js';
import { ThinkingLevel } from '@google/genai';
import { chat, SafetyBlockedError } from '../integrations/google.js';
import type { ChatImage } from '../integrations/google.js';
import { DM_TOOL, executeDm } from './tools/dm.js';
import { IGNORE_TOOL, executeIgnore } from './tools/ignore.js';
import { WEB_SEARCH_TOOL, executeWebSearch } from './tools/webSearch.js';
import { REACT_TOOL, executeReact } from './tools/react.js';
import { PROFILE_TOOL, executeProfile } from './tools/profile.js';
import { checkMessageAccess, resolveIgnoredUser } from './gates.js';
import { resolveUsageQuota, persistDegradedUsage } from './quota.js';
import { buildContextSystemPrompt, buildStaticSystemPrompt, buildStyleHint, stripBotMention } from './context.js';
import { collectImages } from './images.js';
import { maybeSummarize } from './summarize.js';
import { errorEmbed, quotaEmbed } from '../utils/embeds.js';
import { reportFlaggedContent } from '../utils/flagReport.js';
import { blockedLine } from './voiceLines.js';

export interface ProcessResult {
    content: string;
    emotion: string;
    /** When set, the pipeline replies with this embed instead of plain text. */
    embed?: EmbedBuilder;
    components?: ActionRowBuilder<ButtonBuilder>[];
}

export interface ProcessOptions {
    onThinking?: () => () => void;
}

const MEMORY_MAX_CHARS = 160;
const MEMORY_MAX_SLOTS = 30;

const MAX_SANE_REPLY_LENGTH = 1800;
const MAX_TOOL_ROUNDS = 2;
const MODEL_ROW_CAP = 500;

/** Degraded turn placeholder — the user gets an embed, never a fake message. */
function neutralTurn(): AliceTurn {
    return {
        message: '',
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
    let lastDiagnostics: { textLen: number; finishReason: string | null } = {
        textLen: 0,
        finishReason: 'unknown',
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        const isRetry = attempt === 1;
        const { text, model, finishReason } = await chat({
            system,
            // Retry with an explicit JSON-only nudge (new array — never mutate the caller's history).
            messages: isRetry
                ? [...messages, { role: 'user', content: '[system] Return exactly one JSON object now, no prose, no code fences.' }]
                : messages,
            schema: ALICE_TURN_SCHEMA,
            // Retry cooler with minimal reasoning: maximizes the chance of valid JSON.
            ...(isRetry ? { temperature: 0.3, thinking: ThinkingLevel.MINIMAL } : {}),
            ...(apiKey ? { apiKey } : {}),
            ...(images?.length ? { images } : {}),
        });
        lastDiagnostics = {
            textLen: text.length,
            finishReason: finishReason ?? 'unknown',
        };
        const turn = parseAliceTurn(text);
        if (turn) return turn;
        console.warn('[ai] Alice turn parse failed', {
            attempt: attempt + 1,
            model,
            finishReason: finishReason ?? null,
            textLen: text.length,
            preview: text.slice(0, 500),
        });
    }
    throw new AiError(
        `Model produced unusable structured output (lastFinish=${lastDiagnostics.finishReason} lastLen=${lastDiagnostics.textLen}).`,
    );
}

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
                content: '[system] Tools off. Reply in message now.',
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
): Promise<{ reply: string; turn: AliceTurn; degraded: boolean; error?: unknown }> {
    try {
        const turn = await converse(system, messages, executor, byokKey, images);

        const reply = turn.message.trim();
        if (!reply || reply.length > MAX_SANE_REPLY_LENGTH) {
            console.warn('[ai] Unusable reply length, returning error fallback.');
            return {
                reply: '',
                turn: neutralTurn(),
                degraded: true,
                error: new Error('Model returned an empty or oversized response.'),
            };
        }
        return { reply, turn, degraded: false };
    } catch (error) {
        console.error('Generation failed:', error);
        return { reply: '', turn: neutralTurn(), degraded: true, error };
    }
}

const userLocks = new Map<string, Promise<unknown>>();

// Per user+channel so a hung turn in one channel never wedges the user
// everywhere. Stale entries self-evict after TURN_TIMEOUT_MS even if the
// underlying promise never settles.
const TURN_TIMEOUT_MS = 90_000;

function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = userLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const sentinel = run.then(
        () => undefined,
        () => undefined,
    );
    userLocks.set(key, sentinel);
    const cleanup = () => {
        if (userLocks.get(key) === sentinel) userLocks.delete(key);
    };
    void sentinel.then(cleanup);
    setTimeout(cleanup, TURN_TIMEOUT_MS).unref?.();
    return run;
}

export async function processMessage(
    message: Message,
    persona: string | null = null,
    opts: ProcessOptions = {},
): Promise<ProcessResult | null> {
    const author = message.author;
    if (!author || author.bot) return null;

    return withUserLock(`${author.id}:${message.channelId}`, () => handleProcess(message, persona, opts));
}

async function handleProcess(
    message: Message,
    persona: string | null,
    opts: ProcessOptions,
): Promise<ProcessResult | null> {
    const author = message.author;
    const userId = author.id;
    const now = Date.now();

    // Defense-in-depth ToS wall (messageCreate already gates, but direct
    // processMessage callers would otherwise auto-create the user via ensure).
    const gate = await checkMessageAccess(userId);
    if (!gate.ok) return gate.reply;

    const [user, state] = await Promise.all([Users.ensure(userId), getUserState(userId)]);
    if (user.blacklisted) return null;

    const botId = message.client.user?.id ?? null;
    // Bare mention with nothing else is not a message — never fire an LLM turn on it.
    const content = stripBotMention(message.content, botId);
    if (!content) return null;

    // Ignored-but-listening: silence by default, apology-like texts can unignore.
    if (state.ignoredUntil != null && state.ignoredUntil > now) {
        const ignored = await resolveIgnoredUser(userId, author.username, content, state, now);
        if (ignored.ignoredUntil == null) {
            state.ignoredUntil = null; // unignored by the apology eval — fall through
        } else {
            // Still ignored: send the one cold line (first time) or stay silent.
            return ignored.reply ?? null;
        }
    }

    // Usage / vote / BYOK resolution — see quota.ts.
    const usage = await resolveUsageQuota(userId, user, state, now);
    const byokKey = usage.byokKey;
    const isByok = Boolean(byokKey);
    if (usage.blocked) {
        const { embed, components } = quotaEmbed(message.client, usage.blocked.quota, usage.blocked.bonus);
        return { content: '', emotion: 'sad', embed, components };
    }

    // Decay always runs — the hot Redis path is the common case, not the fallback.
    const decayResult = applyMonthlyDecay(normalizeRelationship(state.rel ?? user.relationship), now);
    const decayed = decayResult.decayed;
    let rel: RelationshipState = decayResult.rel;

    if (!message.channel) return null;
    const isDM = message.channel.isDMBased();
    const key = sessionKey(isDM ? null : message.guildId, message.channelId);
    const [session, summary, { images, failed: imagesFailed }] = await Promise.all([
        getSession(key),
        getSessionSummary(key).catch(() => null),
        collectImages(message),
    ]);

    // sinceAt = last status change (any status). A recent change shows subtly for ~24h.
    const statusJustChanged =
        rel.sinceAt != null && now - rel.sinceAt < 24 * 60 * 60 * 1000 && rel.status !== 'stranger';
    const contextPrompt = buildContextSystemPrompt({
        userName: author.username,
        status: rel.status,
        affection: rel.affection,
        lastEmotion: rel.lastEmotion,
        lastInteractionAt: rel.lastInteractionAt,
        now,
        memories: user.memories,
        summary,
        styleHint: buildStyleHint(session, userId),
        statusJustChanged,
    });

    const system = [buildStaticSystemPrompt(persona ?? 'default'), contextPrompt]
        .filter((part) => part !== '')
        .join('\n\n');

    // Live tail only: the head is covered by the rolling summary in the system
    // prompt, so sending it again doubles tokens for zero recall gain.
    const messages: AiMessage[] = [];
    for (const m of session.slice(-SESSION_MODEL_WINDOW)) {
        const safeContent = (m.content ?? '').trim().slice(0, MODEL_ROW_CAP);
        if (!safeContent) continue;
        const safeName = (m.username ?? 'user').trim() || 'user';
        messages.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: `${safeName}: ${safeContent}`,
        });
    }
    // Only genuinely failed downloads get the failure cue — skipped files
    // (oversize, non-image, beyond the 2-image cap) stay silent.
    const imageCue = images.length
        ? '\n[image attached — look at it and answer from what you see]'
        : imagesFailed > 0
          ? '\n[image failed to load — say so plainly once, ask for re-upload]'
          : '';
    messages.push({ role: 'user', content: `${author.username}: ${content}${imageCue}` });

    const executor: AiToolExecutor = (name, args) => {
        const ctx: ToolContext = { message, requesterId: userId };
        if (name === DM_TOOL) return executeDm(ctx, args);
        if (name === IGNORE_TOOL) return executeIgnore(ctx, args);
        if (name === WEB_SEARCH_TOOL) return executeWebSearch(args.query, byokKey);
        if (name === REACT_TOOL) return executeReact(ctx, args);
        if (name === PROFILE_TOOL) return executeProfile(ctx, args);
        throw new Error(`Unknown tool: ${name}`);
    };

    let stopThinking: (() => void) | undefined;
    let reply: string;
    let turn: AliceTurn;
    let degraded: boolean;
    let generationError: unknown;
    try {
        stopThinking = opts.onThinking?.();
        ({ reply, turn, degraded, error: generationError } = await generate(
            system,
            messages,
            executor,
            byokKey,
            images,
        ));
    } finally {
        stopThinking?.();
    }

    if (degraded) {
        // Failures still consume quota — otherwise retries are free and infinite.
        if (!isByok) {
            await persistDegradedUsage(userId, rel, state, usage.vote, usage.usedToday);
        }

        if (generationError instanceof SafetyBlockedError) {
            // Safety filter fired: mod report + plain in-character nudge to the user.
            void reportFlaggedContent(message.client, {
                userId,
                username: author.username,
                channelId: message.channelId,
                guildId: message.guildId,
                triggeredContent: content,
                categories: generationError.categories,
            });
            return {
                content: applyEmojis(blockedLine()),
                emotion: 'sad',
            };
        }

        return {
            content: '',
            emotion: turn.emotion,
            embed: errorEmbed(message.client, isByok),
        };
    }

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
        sinceAt: statusChanged ? now : rel.sinceAt,
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
    // Store history sanitized (invented tags stripped, known [tags] kept raw)
    // so junk markup never pollutes future recall. Delivery stays rendered.
    const historyReply = sanitizeForHistory(reply);
    const newTurns: SessionMessage[] = [
        { role: 'user', authorId: userId, username: author.username, content, ts: now },
        {
            role: 'assistant',
            authorId: botUser?.id ?? 'alice',
            username: botUser?.username ?? 'Alice',
            content: historyReply,
            ts: now,
        },
    ];
    await Promise.all([
        Users.recordMessage(
            userId,
            user,
            memoriesChanged ? memories : undefined,
            relationshipChanged ? rel : undefined,
        ),
        persistTurn(key, newTurns, userId, {
            rel,
            usage: isByok
                ? state.usage
                : { day: usageToday(), count: usage.usedToday + 1 },
            vote: usage.vote,
        }),
    ]);
    // Roll the summary forward in the background — never blocks the reply.
    // Pass the already-fetched summary so the watermark matches the trimmed list.
    void maybeSummarize(
        key,
        [...session, ...newTurns].slice(-SESSION_MAX_MESSAGES),
        summary,
        byokKey,
    );
    return { content: applyEmojis(reply), emotion: turn.emotion };
}
