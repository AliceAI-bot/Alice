import '../config/env.js';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { Content, GenerateContentConfig, GenerateContentResponse } from '@google/genai';
import { AiError, AiMessage } from '../types/ai.js';

export const DEFAULT_MODEL = 'gemma-4-26b-a4b-it';
export const DEFAULT_TEMPERATURE = 1.35;

// Heuristic router: casual smalltalk gets cheap/fast thinking, heavy stuff keeps HIGH.
// Keeps replies snappy while cutting tokens + latency on the 80% of messages that are "lol hey".
const SEARCH_HINT =
    /\b(news|weather|price|score|who won|when did|latest|today|yesterday|release|announce|update|worth|how much|stock|election|game|match|movie|song|album|show)\b/i;
const TOOL_HINT =
    /\b(dm me|text me|send (it|that|this) (privately|in dm|to me)|dm (him|her|them)|ignore|unignore|block (him|her|them)|remind me|remember to|remind (him|her|them)|who (is|are) (he|she|they|this)|do you know (him|her|them))\b/i;
const HEAVY_HINT =
    /\b(sorry|apolog|forgive|miss you|love you|hate you|break ?up|fight|jealous|cried|crying|depress|anxious|suicid|die|dead|trauma|cheat|lied|lie to me)\b/i;

export function pickThinkingLevel(content: string, hasImages: boolean): ThinkingLevel {
    if (hasImages) return ThinkingLevel.HIGH;
    const text = (content ?? '').trim();
    if (!text) return ThinkingLevel.MINIMAL;
    if (text.length > 200 || HEAVY_HINT.test(text) || TOOL_HINT.test(text)) return ThinkingLevel.HIGH;
    if (SEARCH_HINT.test(text) || text.includes('?') || text.length > 40) return ThinkingLevel.MINIMAL;
    return ThinkingLevel.MINIMAL;
}

export function pickGenParams(
    thinking: ThinkingLevel,
): { temperature: number; maxTokens: number } {
    if (thinking === ThinkingLevel.MINIMAL) return { temperature: 1.35, maxTokens: 180 };
    return { temperature: DEFAULT_TEMPERATURE, maxTokens: 600 };
}

const MAX_ATTEMPTS = 4;

interface Pool {
    clients: GoogleGenAI[];
    cursor: number;
}

let pool: Pool | null = null;

function keyPool(): Pool {
    if (pool) return pool;

    const entries = Object.entries(process.env)
        .filter(([name]) => /^google_key_\d+$/.test(name))
        .sort(([a], [b]) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));

    const seen = new Set<string>();
    const clients: GoogleGenAI[] = [];
    for (const [, value] of entries) {
        const key = value?.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        clients.push(new GoogleGenAI({ apiKey: key }));
    }

    if (!clients.length) {
        throw new AiError('No Gemini API keys configured (set google_key_0..N in .env).');
    }

    pool = { clients, cursor: 0 };
    return pool;
}

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function toContents(messages: AiMessage[], images?: ChatImage[]): Content[] {
    const contents: Content[] = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
    }));

    if (images?.length && contents.length) {
        const last = contents[contents.length - 1]!;
        last.parts = [...(last.parts ?? []), ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))];
    }

    return contents;
}

const BYOK_CACHE_MAX = 50;
const byokClients = new Map<string, GoogleGenAI>();

function byokClient(apiKey: string): GoogleGenAI {
    const existing = byokClients.get(apiKey);
    if (existing) {
        byokClients.delete(apiKey);
        byokClients.set(apiKey, existing);
        return existing;
    }

    const client = new GoogleGenAI({ apiKey });
    byokClients.set(apiKey, client);

    const oldest = byokClients.keys().next().value;
    if (byokClients.size > BYOK_CACHE_MAX && oldest !== undefined) {
        byokClients.delete(oldest);
    }
    return client;
}

function resolveClient(apiKey?: string): GoogleGenAI {
    if (apiKey) return byokClient(apiKey);

    const p = keyPool();
    if (!p.clients.length) {
        throw new AiError('All configured Gemini API keys were rejected.');
    }
    return p.clients[p.cursor++ % p.clients.length]!;
}

function dropFromPool(client: GoogleGenAI): void {
    const p = keyPool();
    const index = p.clients.indexOf(client);
    if (index !== -1) p.clients.splice(index, 1);
}

async function resilientCall<T>(
    doCall: (client: GoogleGenAI) => Promise<T>,
    apiKey?: string,
): Promise<T> {
    let lastError = new AiError('AI request failed.');

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let client: GoogleGenAI;
        try {
            client = resolveClient(apiKey);
        } catch (err) {
            throw wrapError(err);
        }

        try {
            return await doCall(client);
        } catch (err) {
            lastError = wrapError(err);

            if (!apiKey && looksLikeBadKey(lastError)) {
                dropFromPool(client);
                continue;
            }
            if (!isRetryable(lastError)) break;

            await sleep(Math.min(2 ** attempt * 500, 5000));
        }
    }
    throw lastError;
}

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
}

function lastUserText(messages: AiMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === 'user') return m.content;
    }
    return '';
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
    const contents = toContents(options.messages, options.images);
    const lastText = lastUserText(options.messages);
    const thinking =
        options.thinking ?? pickThinkingLevel(lastText, Boolean(options.images?.length));
    const auto = pickGenParams(thinking);
    const config: GenerateContentConfig = {
        temperature: options.temperature ?? auto.temperature,
        thinkingConfig: { thinkingLevel: thinking },
    };
    if (options.system) config.systemInstruction = options.system;
    config.maxOutputTokens = options.maxTokens ?? auto.maxTokens;
    if (options.schema) {
        config.responseMimeType = 'application/json';
        config.responseSchema = options.schema as never;
    }

    return resilientCall(async (client) => {
        const response: GenerateContentResponse = await client.models.generateContent({
            model: DEFAULT_MODEL,
            contents,
            config,
        });
        return { text: response.text ?? '', model: response.modelVersion ?? DEFAULT_MODEL, thinking };
    }, options.apiKey);
}

export interface GroundedResult {
    text: string;
    sources: Array<{ title: string | null; uri: string | null }>;
}

function extractGrounded(response: GenerateContentResponse): GroundedResult {
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = chunks
        .map((chunk) => ({ title: chunk.web?.title ?? null, uri: chunk.web?.uri ?? null }))
        .filter((s): s is { title: string | null; uri: string | null } => Boolean(s.uri))
        .slice(0, 5);

    return { text: response.text ?? '', sources };
}

export async function groundedSearch(query: string, apiKey?: string): Promise<GroundedResult> {
    const contents: Content[] = [{ role: 'user', parts: [{ text: query }] }];
    const config: GenerateContentConfig = {
        temperature: 0.3,
        maxOutputTokens: 2048,
        tools: [{ googleSearch: {} }],
    };

    return resilientCall(async (client) => {
        const response = await client.models.generateContent({
            model: DEFAULT_MODEL,
            contents,
            config,
        });
        return extractGrounded(response);
    }, apiKey);
}

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
