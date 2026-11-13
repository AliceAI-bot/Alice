import '../config/env.js';
import {
    GoogleGenAI,
    HarmBlockThreshold,
    HarmCategory,
    MediaResolution,
    ThinkingLevel,
} from '@google/genai';
import type { Content, GenerateContentConfig, GenerateContentResponse } from '@google/genai';
import { AiError, AiMessage } from '../types/ai.js';

// ----------------------------------------------------------- model constants

const MODEL = 'gemini-3.5-flash-lite';

// Casual chat wants a hot temp; structured JSON needs a cool one plus headroom
// for reasoning + JSON. (HIGH thinking + a small budget starves the JSON and
// yields empty/truncated text that fails JSON.parse every time.)
const CASUAL = { temperature: 1.3, maxTokens: 600 } as const;
const STRUCTURED = { temperature: 0.8, maxTokens: 1500 } as const;

// Only the highest-severity content is blocked. Explicit 18+ is intentionally
// unfiltered (18+ bot per ToS); harassment is pinned so API defaults can't drift.
const SAFETY_SETTINGS = [
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

/** Raised when Gemini blocked the prompt/response on a safety category. Not retried. */
export class SafetyBlockedError extends AiError {
    /** HARM_CATEGORY_* values the model actually blocked, when reported. */
    readonly categories: string[];

    constructor(message: string, categories: string[] = [], body: unknown = null) {
        super(message, 400, body);
        this.name = 'SafetyBlockedError';
        this.categories = categories;
    }
}

// ----------------------------------------------------------- retry + cooldown

const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;
/** A rate-limited key is temporarily kicked out of rotation for this long. */
const KEY_COOLDOWN_MS = 30_000;

/** One API key (shared pool or BYOK) with its transient 429 cooldown. */
interface Slot {
    client: GoogleGenAI;
    /** 0 = healthy; else earliest timestamp the key may be used again. */
    coolUntil: number;
}

let shared: Slot[] | null = null;
let cursor = 0;

function sharedPool(): Slot[] {
    if (shared) return shared;

    const seen = new Set<string>();
    shared = Object.entries(process.env)
        .filter(([name]) => /^google_key_\d+$/.test(name))
        .toSorted(([a], [b]) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
        .flatMap(([, value]) => {
            const key = value?.trim();
            if (!key || seen.has(key)) return [];
            seen.add(key);
            return [{ client: new GoogleGenAI({ apiKey: key }), coolUntil: 0 }];
        });

    if (!shared.length) {
        throw new AiError('No Gemini API keys configured (set google_key_0..N in .env).');
    }
    return shared;
}

/** Round-robin preferring healthy keys; all-cooling falls back to the soonest recovery. */
function takeSharedSlot(): Slot {
    const pool = sharedPool();
    if (!pool.length) throw new AiError('All configured Gemini API keys were rejected.');

    const now = Date.now();
    for (let i = 0; i < pool.length; i++) {
        const slot = pool[cursor++ % pool.length]!;
        if (slot.coolUntil <= now) return slot;
    }
    return pool.toSorted((a, b) => a.coolUntil - b.coolUntil)[0]!;
}

/** Bad keys never come back. */
function dropShared(slot: Slot): void {
    const index = shared?.indexOf(slot) ?? -1;
    if (index !== -1) shared!.splice(index, 1);
}

function markCooling(slot: Slot): void {
    slot.coolUntil = Date.now() + KEY_COOLDOWN_MS;
}

function markHealthy(slot: Slot): void {
    slot.coolUntil = 0;
}

const BYOK_CACHE_MAX = 50;
const byokClients = new Map<string, Slot>();

function byokSlot(apiKey: string): Slot {
    const existing = byokClients.get(apiKey);
    if (existing) {
        // Re-insert to keep the Map acting as an LRU.
        byokClients.delete(apiKey);
        byokClients.set(apiKey, existing);
        return existing;
    }

    const slot: Slot = { client: new GoogleGenAI({ apiKey }), coolUntil: 0 };
    byokClients.set(apiKey, slot);
    if (byokClients.size > BYOK_CACHE_MAX) {
        const oldest = byokClients.keys().next().value;
        if (oldest !== undefined) byokClients.delete(oldest);
    }
    return slot;
}

/** A BYOK key known rate-limited fails fast instead of hammering Google again. */
function throwIfByokCooling(apiKey: string): void {
    const slot = byokClients.get(apiKey);
    if (slot && slot.coolUntil > Date.now()) {
        throw new AiError('Your API key is rate limited right now — try again in a moment.', 429);
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function wrapError(err: unknown): AiError {
    if (err instanceof AiError) return err;
    const e = err as { status?: unknown; code?: unknown; message?: unknown };
    const status =
        typeof e?.status === 'number' ? e.status : typeof e?.code === 'number' ? e.code : 0;
    const message =
        typeof e?.message === 'string' && e.message ? e.message : 'AI request failed.';
    return new AiError(message, status, err);
}

function isRetryable(err: AiError): boolean {
    return err.status === 0 || err.status === 429 || err.status >= 500;
}

function looksLikeBadKey(err: AiError): boolean {
    return (
        err.status === 401 ||
        err.status === 403 ||
        /API_KEY_INVALID|API key not valid/i.test(String(err.message))
    );
}

/**
 * Run a model call across up to MAX_ATTEMPTS with key rotation:
 * 429 -> cooldown + try another key, bad key -> dropped from the pool,
 * other errors -> retry with capped exponential backoff.
 */
async function resilientCall<T>(
    doCall: (client: GoogleGenAI) => Promise<T>,
    apiKey?: string,
): Promise<T> {
    if (apiKey) throwIfByokCooling(apiKey);

    let lastError = new AiError('AI request failed.');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let slot: Slot;
        try {
            slot = apiKey ? byokSlot(apiKey) : takeSharedSlot();
        } catch (err) {
            throw wrapError(err);
        }

        try {
            const result = await doCall(slot.client);
            markHealthy(slot);
            return result;
        } catch (err) {
            lastError = wrapError(err);

            if (looksLikeBadKey(lastError)) {
                if (!apiKey) dropShared(slot);
                continue;
            }
            if (lastError.status === 429) markCooling(slot);
            if (!isRetryable(lastError)) break;

            await sleep(Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS));
        }
    }
    throw lastError;
}

// ----------------------------------------------------------- chat

export interface ChatImage {
    mimeType: string;
    data: string;
}

export interface ChatOptions {
    system?: string;
    messages: AiMessage[];
    images?: ChatImage[];
    temperature?: number;
    maxTokens?: number;
    thinking?: ThinkingLevel;
    schema?: unknown;
    apiKey?: string;
}

export interface ChatResult {
    text: string;
    model: string;
    thinking: ThinkingLevel;
    finishReason?: string | null | undefined;
    usage?:
        | {
              promptTokens?: number | undefined;
              candidatesTokens?: number | undefined;
              thoughtsTokens?: number | undefined;
              totalTokens?: number | undefined;
          }
        | undefined;
}

function toContents(messages: AiMessage[], images?: ChatImage[]): Content[] {
    const contents: Content[] = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
    }));

    if (images?.length && contents.length) {
        const last = contents.at(-1)!;
        last.parts = [...(last.parts ?? []), ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))];
    }

    return contents;
}

/** HARM_CATEGORY_* names Google explicitly blocked this response for. */
function blockedCategories(candidate: unknown): string[] {
    const ratings = (candidate as { safetyRatings?: unknown } | null | undefined)?.safetyRatings;
    if (!Array.isArray(ratings)) return [];
    return ratings.flatMap((rating) => {
        const r = rating as { blocked?: unknown; category?: unknown } | null;
        return r?.blocked === true && typeof r.category === 'string' ? [r.category] : [];
    });
}

/** Non-SAFETY finish reasons that still mean "the response content was withheld". */
const BLOCK_FINISH_REASONS: ReadonlySet<string> = new Set(['BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

function toChatResult(
    response: GenerateContentResponse,
    thinking: ThinkingLevel,
    structured: boolean,
): ChatResult {
    const text = response.text ?? '';
    const candidate = response.candidates?.[0];
    const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : null;
    const categories = blockedCategories(candidate);
    const feedback = (response as { promptFeedback?: { blockReason?: unknown } }).promptFeedback;

    // Any promptFeedback.blockReason means the prompt itself was rejected.
    const safetyTriggered =
        finishReason === 'SAFETY' ||
        categories.length > 0 ||
        (feedback?.blockReason != null && feedback.blockReason !== '') ||
        (!text && finishReason != null && BLOCK_FINISH_REASONS.has(finishReason));
    if (!text && safetyTriggered) {
        throw new SafetyBlockedError(`Safety filter blocked the response (finishReason=${finishReason ?? 'unknown'}).`, categories, {
            finishReason,
            categories,
            promptFeedback: feedback ?? null,
        });
    }

    const usageRaw = (response as unknown as { usageMetadata?: Record<string, unknown> }).usageMetadata;
    const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const usage = usageRaw
        ? {
              promptTokens: num(usageRaw.promptTokenCount),
              candidatesTokens: num(usageRaw.candidatesTokenCount),
              thoughtsTokens: num(usageRaw.thoughtsTokenCount),
              totalTokens: num(usageRaw.totalTokenCount),
          }
        : undefined;

    if (!text) {
        console.warn('[ai] empty model text', {
            model: MODEL,
            finishReason,
            usage,
            thinking: String(thinking),
            structured,
        });
    }
    return { text, model: response.modelVersion ?? MODEL, thinking, finishReason, usage };
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
    const isStructured = Boolean(options.schema);
    const thinking = options.thinking ?? (isStructured ? ThinkingLevel.LOW : ThinkingLevel.HIGH);
    const params = isStructured ? STRUCTURED : CASUAL;
    const config: GenerateContentConfig = {
        temperature: options.temperature ?? params.temperature,
        maxOutputTokens: options.maxTokens ?? params.maxTokens,
        thinkingConfig: { thinkingLevel: thinking },
        safetySettings: SAFETY_SETTINGS,
    };
    if (options.system) config.systemInstruction = options.system;
    // 2 images max and only for casual image chat — LOW keeps vision tokens ~280/img.
    if (options.images?.length) config.mediaResolution = MediaResolution.MEDIA_RESOLUTION_LOW;
    if (options.schema) {
        config.responseMimeType = 'application/json';
        config.responseSchema = options.schema as never;
    }

    const contents = toContents(options.messages, options.images);
    return resilientCall(
        async (client) => {
            const response = await client.models.generateContent({ model: MODEL, contents, config });
            return toChatResult(response, thinking, isStructured);
        },
        options.apiKey,
    );
}

// ----------------------------------------------------------- grounded search

export interface GroundedResult {
    text: string;
    sources: Array<{ title: string | null; uri: string | null }>;
}

export async function groundedSearch(query: string, apiKey?: string): Promise<GroundedResult> {
    const contents: Content[] = [{ role: 'user', parts: [{ text: query }] }];
    const config: GenerateContentConfig = {
        temperature: 0.3,
        maxOutputTokens: 800,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        tools: [{ googleSearch: {} }],
        safetySettings: SAFETY_SETTINGS,
    };

    return resilientCall(async (client) => {
        const response = await client.models.generateContent({ model: MODEL, contents, config });
        const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const sources = chunks
            .flatMap((chunk) => {
                const uri = chunk.web?.uri ?? null;
                return uri ? [{ title: chunk.web?.title ?? null, uri }] : [];
            })
            .slice(0, 5);
        return { text: response.text ?? '', sources };
    }, apiKey);
}

// ----------------------------------------------------------- key validation

export interface KeyCheckResult {
    valid: boolean;
    error?: string;
}

export async function keycheck(apiKey: string): Promise<KeyCheckResult> {
    if (!apiKey || !apiKey.trim()) {
        return { valid: false, error: 'No API key provided.' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
        const pager = await ai.models.list();
        for await (const model of pager) {
            void model;
            break;
        }
        return { valid: true };
    } catch (err) {
        const wrapped = wrapError(err);
        if (looksLikeBadKey(wrapped)) {
            return { valid: false, error: 'Invalid API key. Double-check it on https://aistudio.google.com/apikey.' };
        }
        if (wrapped.status === 429) {
            return { valid: false, error: 'Rate limited by Google, try again in a moment.' };
        }
        return {
            valid: false,
            error: wrapped.status ? wrapped.message.slice(0, 200) : 'Could not reach the Gemini API, try again later.',
        };
    }
}
