import type { Message } from 'discord.js';

export type AiRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
    role: AiRole;
    content: string;
}

export class AiError extends Error {
    status: number;
    body: unknown;

    constructor(message: string, status = 0, body: unknown = null) {
        super(message);
        this.name = 'AiError';
        this.status = status;
        this.body = body;
    }
}

export interface AiToolExecutor {
    (name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ToolContext {
    message: Message;
    requesterId: string;
}

export const EMOTIONS = [
    'neutral',
    'happy',
    'amused',
    'affectionate',
    'flirty',
    'sad',
    'annoyed',
    'angry',
    'surprised',
    'worried',
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export const TOOL_NAMES = [
    'web_search',
    'dm_user',
    'ignore_user',
    'react_to_message',
    'get_user_profile',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface MemoryAction {
    action: 'remember' | 'forget';
    text: string;
}

export interface ToolRequest {
    name: ToolName;
    query?: string;
    target?: string;
    message?: string;
    action?: 'ignore' | 'unignore';
    emoji?: string;
}

export function toolRequestArgs(req: ToolRequest): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (req.query !== undefined) args.query = req.query;
    if (req.target !== undefined) args.target = req.target;
    if (req.message !== undefined) args.message = req.message;
    if (req.action !== undefined) args.action = req.action;
    if (req.emoji !== undefined) args.emoji = req.emoji;
    return args;
}

export interface AliceTurn {
    message: string;
    emotion: Emotion;
    relationshipDelta: number;
    memoryAction: MemoryAction | null;
    toolCall: ToolRequest | null;
}

export const ALICE_TURN_SCHEMA = {
    type: 'OBJECT',
    properties: {
        message: { type: 'STRING', description: 'Reply as Alice. Empty only if tool_call set. Conversation = messages below; recall questions: answer factually from history. Asked to explain: substantive first, no empty tease. Image attached: describe it, never claim blind. Never repeat last turns; \\n\\n = 2 bubbles rare. Most msgs one [happy/angry/wave/scared/confused/excited/joy/eating/dizzy/wtf] max one per turn, never Unicode in message. Do not just echo. May outright refuse disliked requests; NSFW only with ToS-accepted adults.' },
        emotion: { type: 'STRING', enum: [...EMOTIONS] },
        relationship_delta: {
            type: 'INTEGER',
            description: '-3..+3, 0 = smalltalk.',
        },
        memory_action: {
            type: 'OBJECT',
            nullable: true,
            description: 'One fact or null.',
            properties: {
                action: { type: 'STRING', enum: ['remember', 'forget'] },
                text: { type: 'STRING', description: 'Fact to keep, or exact one to drop.' },
            },
            required: ['action', 'text'],
        },
        tool_call: {
            type: 'OBJECT',
            nullable: true,
            description: 'Tool instead of reply; null when done/unneeded. Only that tool fields.',
            properties: {
                name: { type: 'STRING', enum: [...TOOL_NAMES] },
                query: { type: 'STRING', description: 'web_search ONLY.' },
                target: { type: 'STRING', description: 'dm/ignore/profile ONLY: <@id>. Omit = current.' },
                message: { type: 'STRING', description: 'dm_user ONLY.' },
                action: { type: 'STRING', enum: ['ignore', 'unignore'], description: 'ignore_user ONLY.' },
                emoji: { type: 'STRING', description: 'react ONLY, Unicode one of ❤️😂🫂😭💀. Rare 3-5%. Never [tag] here.' },
            },
            required: ['name'],
        },
    },
    required: ['message', 'emotion', 'relationship_delta', 'memory_action', 'tool_call'],
} as const;

const EMOTION_SET: ReadonlySet<string> = new Set(EMOTIONS);
const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

function parseMemoryAction(raw: unknown): MemoryAction | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if ((o.action !== 'remember' && o.action !== 'forget') || typeof o.text !== 'string' || !o.text.trim()) {
        return null;
    }
    return { action: o.action, text: o.text.trim() };
}

function parseToolCall(raw: unknown): ToolRequest | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== 'string' || !TOOL_NAME_SET.has(o.name)) return null;

    const req: ToolRequest = { name: o.name as ToolName };
    if (typeof o.query === 'string' && o.query.trim()) req.query = o.query.trim();
    if (typeof o.target === 'string' && o.target.trim()) req.target = o.target.trim();
    if (typeof o.message === 'string') req.message = o.message;
    if (o.action === 'ignore' || o.action === 'unignore') req.action = o.action;
    if (typeof o.emoji === 'string' && o.emoji.trim()) req.emoji = o.emoji.trim();
    return req;
}

export function parseAliceTurn(rawText: string): AliceTurn | null {
    let obj: unknown;
    try {
        obj = JSON.parse(rawText);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;

    const o = obj as Record<string, unknown>;
    const emotionRaw = typeof o.emotion === 'string' ? o.emotion : '';
    const deltaRaw = o.relationship_delta;

    return {
        message: typeof o.message === 'string' ? o.message : '',
        emotion: (EMOTION_SET.has(emotionRaw) ? emotionRaw : 'neutral') as Emotion,
        relationshipDelta:
            typeof deltaRaw === 'number' && Number.isFinite(deltaRaw)
                ? Math.max(-3, Math.min(3, Math.trunc(deltaRaw)))
                : 0,
        memoryAction: parseMemoryAction(o.memory_action),
        toolCall: parseToolCall(o.tool_call),
    };
}
