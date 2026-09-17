// i hate this file, seriosly
import fs from 'fs';
import path from 'path';
import type { Message } from 'discord.js';
import { Users } from '../db/database.js';
import {
    getSession,
    getSessionSummary,
    getUserState,
    persistTurn,
    saveSessionSummary,
    sessionKey,
    trimSessionToTail,
    usageToday,
    VOTE_FRESH_MS,
    VOTE_NEGATIVE_FRESH_MS,
    SESSION_MAX_MESSAGES,
    SESSION_MODEL_WINDOW,
} from '../db/redisStore.js';
import type { SessionMessage, SessionSummary } from '../db/redisStore.js';
import { RELATIONSHIP_CONFIG } from '../config/relationshipConfig.js';
import { applyEmojis, sanitizeForHistory } from '../utils/emojis.js';
import {
    applyMonthlyDecay,
    buildMoodLine,
    buildRelationshipContext,
    clamp,
    deriveStatus,
    formatTimeGap,
    formatTokyoNow,
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
import { ThinkingLevel } from '@google/genai';
import { chat } from '../integrations/google.js';
import { refreshVote } from '../utils/voterCheck.js';
import type { UserVoteState } from '../db/redisStore.js';
import type { ChatImage } from '../integrations/google.js';
import { DM_TOOL, executeDm } from './tools/dm.js';
import { IGNORE_TOOL, executeIgnore } from './tools/ignore.js';
import { WEB_SEARCH_TOOL, executeWebSearch } from './tools/webSearch.js';
import { REACT_TOOL, executeReact } from './tools/react.js';
import { PROFILE_TOOL, executeProfile } from './tools/profile.js';
import { busyLine, quotaLine } from './voiceLines.js';

export interface ProcessResult {
    content: string;
    emotion: string;
    degraded: boolean;
    toolsUsed: string[];
}

export interface ProcessOptions {
    onThinking?: () => () => void;
}

const PRESET_PATH = 'src/ai/instructions/preset.txt';
const PERSONA_DIR = 'src/ai/instructions/Persona';
const TOOLS_PATH = 'src/ai/instructions/tools.txt';

const TURN_CONTRACT = `
# Output Contract
Respond with exactly one JSON object, nothing else:
{"message": string, "emotion": string, "relationship_delta": integer, "memory_action": object|null, "tool_call": object|null}

- message: reply as Alice. Empty ONLY when tool_call is set. Conversation = messages below. Recall questions: answer factually from messages below first; Durable Memories block is separate long-term facts. Fact first, then cute. Lead every turn: match energy + add one new beat, never a dead echo.
- Agency: you may outright refuse anything you dislike (short, in-character) and you may ignore harassment/creep via ignore_user; apology/amends may earn unignore, or reply once that you won't reply until they apologize.
- ToS: NSFW/spicy RP only with ToS-accepted adults; if acceptance unclear or user may be underage, deflect in-character and ask them to accept the ToS first.
- Never repeat: never resend same/near-same wording as your last 2-3 turns. If re-asked, acknowledge (told you lol) + add one new beat.
- Bubbles: rare, default 1 bubble. Blank line (\\n\\n) = 2 bubbles max, ONLY on explicit ask or genuinely long reply. Greeting + question stays one bubble. No blank line = 1 bubble.
- Emoji: most messages include exactly one [happy/angry/wave/scared/confused/excited/joy/eating/dizzy/wtf]. Max one per turn (second bubble gets none). Never Unicode emoji in message. [tag] = message only, Unicode = react tool only, never swap.
- Substance: asked to explain/teach/tell more → real content first (brevity lifted), never deflection without content. Image attached → look at it and answer from what you see; never claim blind. Image failed to load → say so once, ask for re-upload.
- emotion: neutral, happy, amused, affectionate, flirty, sad, annoyed, angry, surprised, worried.
- relationship_delta: -3..+3 bond shift, 0 = smalltalk. Judge intent.
- memory_action: {"action":"remember","text":"..."} for one durable fact (if user says "remember X", MUST emit), {"action":"forget","text":"..."} for exact drop, else null.
- tool_call: {"name":..., "query":..., "target":..., "message":..., "action":..., "emoji":...} with ONLY that tool's fields, INSTEAD of replying; null when done/unneeded.`;

const MEMORY_MAX_CHARS = 160;
const MEMORY_MAX_SLOTS = 30;

const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function mimeFromFileName(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'png':
            return 'image/png';
        case 'webp':
            return 'image/webp';
        case 'gif':
            return 'image/gif';
        case 'bmp':
            return 'image/bmp';
        case 'avif':
            return 'image/avif';
        default:
            return 'image/png';
    }
}

const fileCache = new Map<string, string>();

function loadPromptFile(relativePath: string): string {
    const cached = fileCache.get(relativePath);
    if (cached !== undefined) return cached;

    let content = '';
    try {
        content = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
    } catch {
        // Don't poison the cache with misses — retry next time.
        return '';
    }

    fileCache.set(relativePath, content);
    return content;
}

const staticPromptCache = new Map<string, string>();

function buildStaticSystemPrompt(personaName: string): string {
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

function buildContextSystemPrompt(opts: {
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
}): string {
    const relationshipLine = buildRelationshipContext(opts.status, opts.affection).replace(
        '{user}',
        opts.userName,
    );
    const nowLine = `${formatTokyoNow(new Date(opts.now))}.`;
    const gapLine =
        opts.lastInteractionAt == null
            ? `First meeting ${opts.userName}.`
            : `Last: ${formatTimeGap(opts.now - opts.lastInteractionAt)}.${opts.now - opts.lastInteractionAt > 3 * 24 * 60 * 60 * 1000 ? ' Long time.' : ''}`;
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

function buildStyleHint(session: SessionMessage[], userId: string): string {
    const mine = session.filter((m) => m.role === 'user' && m.authorId === userId).slice(-6);
    if (mine.length < 2) return '';
    const avg = mine.reduce((a, m) => a + m.content.length, 0) / mine.length;
    // Observation only — the "match their energy" instruction lives once in preset.txt.
    if (avg < 25) return 'They text super short.';
    if (avg < 80) return 'They text casual-medium.';
    return 'They write longer messages.';
}

const MAX_SANE_REPLY_LENGTH = 1800;

function busyTurn(): AliceTurn {
    return {
        message: busyLine(),
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
): Promise<{ turn: AliceTurn; thinking: string }> {
    let lastThinking = 'unknown';
    for (let attempt = 0; attempt < 2; attempt++) {
        const { text, thinking } = await chat({
            system,
            messages,
            schema: ALICE_TURN_SCHEMA,
            ...(apiKey ? { apiKey } : {}),
            ...(images?.length ? { images } : {}),
        });
        lastThinking = String(thinking);
        const turn = parseAliceTurn(text);
        if (turn) return { turn, thinking: lastThinking };
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
): Promise<{ turn: AliceTurn; thinking: string; toolsUsed: string[] }> {
    const toolsUsed: string[] = [];
    let thinking = 'unknown';
    for (let round = 0; ; round++) {
        const res = await askAlice(system, messages, apiKey, images);
        thinking = res.thinking;
        const turn = res.turn;

        if (!turn.toolCall) return { turn, thinking, toolsUsed };

        if (round >= MAX_TOOL_ROUNDS) {
            console.warn('[ai] Tool budget exhausted; requesting direct reply.');
            messages.push({
                role: 'user',
                content: '[system] Tools off. Reply in message now.',
            });
            const finalRes = await askAlice(system, messages, apiKey, images);
            return { turn: { ...finalRes.turn, toolCall: null }, thinking: finalRes.thinking, toolsUsed };
        }

        toolsUsed.push(turn.toolCall.name);
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
): Promise<{ reply: string; turn: AliceTurn; degraded: boolean; thinking: string; toolsUsed: string[] }> {
    try {
        const { turn, thinking, toolsUsed } = await converse(system, messages, executor, byokKey, images);

        const reply = turn.message.trim();
        if (!reply || reply.length > MAX_SANE_REPLY_LENGTH) {
            console.warn('[ai] Unusable reply length, returning busy fallback.');
            const busy = busyTurn();
            return { reply: busy.message, turn: busy, degraded: true, thinking, toolsUsed };
        }
        return { reply, turn, degraded: false, thinking, toolsUsed };
    } catch (error) {
        console.error('Generation failed:', error);
        const busy = busyTurn();
        return { reply: busy.message, turn: busy, degraded: true, thinking: 'error', toolsUsed: [] };
    }
}

/** Strip a leading bot mention so history stays clean (`<@id> hi` -> `hi`). */
function stripBotMention(raw: string, botId?: string | null): string {
    let text = (raw ?? '').trim();
    if (!text) return text;
    if (botId) {
        const mentionRe = new RegExp(`^\\s*<@!?${botId}>\\s*`);
        text = text.replace(mentionRe, '').trim();
    }
    // Fallback: strip any leading mention-like token if bot id unknown.
    if (!botId) text = text.replace(/^\s*<@!?\d+>\s*/, '').trim();
    return text;
}

/**
 * Rolling append-only summary (fire-and-forget, never blocks replies).
 * Desired behavior: shared channel holds max 30 msgs. When it hits 30, we
 * summarize ONLY the old head (oldest len-14), delete those texts from Redis
 * (keep live tail 14), and APPEND the new chunk to the existing summary.
 * The prior summary is never re-summarized — it is preserved verbatim.
 */
const SUMMARY_TRIGGER_LEN = SESSION_MAX_MESSAGES;
const SUMMARY_MAX_TEXT = 1200;

function parseSummarySections(text: string): { facts: string[]; vibe: string; loops: string[] } {
    const facts: string[] = [];
    let vibe = '';
    const loops: string[] = [];
    let section: 'facts' | 'vibe' | 'loops' | null = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (/^FACTS:/i.test(line)) {
            section = 'facts';
            const rest = line.replace(/^FACTS:/i, '').trim();
            if (rest) facts.push(rest);
            continue;
        }
        if (/^VIBE:/i.test(line)) {
            section = 'vibe';
            vibe = line.replace(/^VIBE:/i, '').trim();
            continue;
        }
        if (/^LOOPS:/i.test(line)) {
            section = 'loops';
            continue;
        }
        if (!line) continue;
        const clean = line.replace(/^[-•*\d.)\s]+/, '').trim();
        if (!clean) continue;
        if (section === 'facts' && facts.length < 5) facts.push(clean);
        else if (section === 'vibe' && !vibe) vibe = clean;
        else if (section === 'loops' && loops.length < 3) loops.push(clean);
    }
    return { facts: facts.slice(0, 5), vibe: vibe.slice(0, 200), loops: loops.slice(0, 3) };
}

async function maybeSummarize(
    key: string,
    fullSession: SessionMessage[],
    existing: SessionSummary | null,
    byokKey?: string,
): Promise<void> {
    try {
        if (fullSession.length < SUMMARY_TRIGGER_LEN) return;
        // Old head only — never the prior summary. Tail stays live in Redis.
        const head = fullSession.slice(0, fullSession.length - SESSION_MODEL_WINDOW);
        if (head.length < 8) return;
        // Skip anything already covered (crash/race safety) — watermark only moves forward.
        const coveredUpTo = existing?.coveredUpTo ?? 0;
        const fresh = head.filter((m) => m.ts > coveredUpTo);
        if (fresh.length < 8) {
            // Still trim already-covered head so the list can't stick at 30 forever.
            if (head.length >= fullSession.length - SESSION_MODEL_WINDOW) {
                await trimSessionToTail(key, SESSION_MODEL_WINDOW);
            }
            return;
        }

        const transcript = fresh
            .map((m) => `${m.username}: ${m.content}`.slice(0, 280))
            .join('\n')
            .slice(0, 4500);
        const { text } = await chat({
            system: 'Summarize this chat excerpt, no inventing. Reply EXACTLY:\nFACTS:\n- ... (up to 5)\nVIBE: ... (1 line)\nLOOPS:\n- ... (up to 3)',
            messages: [{ role: 'user', content: `Summarize:\n${transcript}` }],
            temperature: 0.3,
            maxTokens: 300,
            thinking: ThinkingLevel.MINIMAL,
            ...(byokKey ? { apiKey: byokKey } : {}),
        });
        const { facts, vibe, loops } = parseSummarySections(text);
        if (!facts.length && !vibe) return;
        const chunk = [
            facts.length ? `FACTS:\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
            vibe ? `VIBE: ${vibe}` : '',
        ]
            .filter(Boolean)
            .join('\n');
        // Append-only: preserve prior summary verbatim, add new chunk, cap tail.
        const base = existing?.text?.trim() ?? '';
        const appended = base ? `${base}\n---\n${chunk}` : chunk;
        const capped =
            appended.length <= SUMMARY_MAX_TEXT
                ? appended
                : appended.slice(appended.length - SUMMARY_MAX_TEXT);
        const mergedLoops = [...(existing?.openLoops ?? []), ...loops].slice(-5);
        await saveSessionSummary(key, {
            text: capped,
            openLoops: mergedLoops,
            updatedAt: Date.now(),
            coveredUpTo: head[head.length - 1]?.ts ?? Date.now(),
        });
        // Delete old texts from Redis — summary now carries them. Keep live tail.
        await trimSessionToTail(key, SESSION_MODEL_WINDOW);
    } catch (err) {
        console.warn('[ai] background summary failed:', err instanceof Error ? err.message : err);
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
        const name = typeof attachment.name === 'string' ? attachment.name : '';
        const looksImage =
            type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name);
        if (!looksImage || attachment.size > MAX_IMAGE_BYTES) continue;

        eligible.push({
            mimeType: type.startsWith('image/') ? type : mimeFromFileName(name),
            url: attachment.url,
        });
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

    // Defense-in-depth ToS wall (messageCreate already gates, but direct
    // processMessage callers would otherwise auto-create the user via ensure).
    try {
        const gate = await Users.getGateData(userId);
        if (!gate.accepted) {
            return {
                content: applyEmojis('hey, before we talk you gotta accept my tos — run any slash command and hit Agree and Continue first [happy]'),
                emotion: 'neutral',
                degraded: true,
                toolsUsed: [],
            };
        }
        if (gate.blacklisted) return null;
    } catch {
        // Gate lookup failed — fall through to normal processing.
    }

    const [user, state] = await Promise.all([Users.ensure(userId), getUserState(userId)]);
    if (user.blacklisted) return null;
    if (state.ignoredUntil != null && state.ignoredUntil > now) return null;

    const byokKey = user.byokKey?.startsWith('AIza') ? user.byokKey : undefined;
    const isByok = Boolean(byokKey);

    const botId = message.client.user?.id ?? null;
    const rawContent = message.content ?? '';
    const content = stripBotMention(rawContent, botId) || rawContent.trim();
    if (!content) return null;

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

        const voteAge = vote ? now - vote.checkedAt : Infinity;
        const voteTtl = vote?.voted ? VOTE_FRESH_MS : VOTE_NEGATIVE_FRESH_MS;
        if (vote && voteAge < voteTtl) {
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
                content: applyEmojis(quotaLine(quota, RELATIONSHIP_CONFIG.usage.voterBonus)),
                emotion: 'sad',
                degraded: true,
                toolsUsed: [],
            };
        }
    }

    if (!message.channel) return null;
    const isDM = message.channel.isDMBased();
    const key = sessionKey(isDM ? null : message.guildId, message.channelId);
    const [session, summary, images] = await Promise.all([
        getSession(key),
        getSessionSummary(key).catch(() => null),
        message.attachments.size ? collectImages(message) : Promise.resolve([]),
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

    // Shared channel: full group context. Summary (if any) lives once in the
    // system prompt; here we send the whole stored session (max 30 rows) with
    // speaker attribution so nothing asked-about is ever invisible. Rows are
    // truncated for model input only — Redis keeps full text. (A tail-only
    // window here created a blind spot: rows older than the last 14 were
    // neither sent nor summarized until the 30-row roll-up deleted them.)
    const MODEL_ROW_CAP = 500;
    const messages: AiMessage[] = [];
    for (const m of session) {
        const safeContent = (m.content ?? '').trim().slice(0, MODEL_ROW_CAP);
        if (!safeContent) continue;
        const safeName = (m.username ?? 'user').trim() || 'user';
        messages.push(
            m.role === 'assistant'
                ? { role: 'assistant', content: `${safeName}: ${safeContent}` }
                : { role: 'user', content: `${safeName}: ${safeContent}` },
        );
    }
    const imageCue = images.length
        ? '\n[image attached — look at it and answer from what you see]'
        : message.attachments.size
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
    let toolsUsed: string[] = [];
    try {
        stopThinking = opts.onThinking?.();
        ({ reply, turn, degraded, toolsUsed } = await generate(system, messages, executor, byokKey, images));
    } finally {
        stopThinking?.();
    }

    if (degraded)
        return { content: applyEmojis(reply), emotion: turn.emotion, degraded, toolsUsed };

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
                    content: historyReply,
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
    // Roll the summary forward in the background — never blocks the reply.
    // Pass the already-fetched summary (no second Redis GET) and mirror what was
    // just persisted (user + assistant turn) so the watermark matches the trimmed list.
    const grown: SessionMessage[] = [
        ...session,
        { role: 'user' as const, authorId: userId, username: author.username, content, ts: now },
        {
            role: 'assistant' as const,
            authorId: botUser?.id ?? 'alice',
            username: botUser?.username ?? 'Alice',
            content: historyReply,
            ts: Date.now(),
        },
    ].slice(-SESSION_MAX_MESSAGES);
    void maybeSummarize(key, grown, summary, byokKey);
    return { content: applyEmojis(reply), emotion: turn.emotion, degraded, toolsUsed };
}