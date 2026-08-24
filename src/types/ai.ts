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

export const TOOL_NAMES = ['web_search', 'dm_user', 'ignore_user'] as const;

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
}

export function toolRequestArgs(req: ToolRequest): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (req.query !== undefined) args.query = req.query;
    if (req.target !== undefined) args.target = req.target;
    if (req.message !== undefined) args.message = req.message;
    if (req.action !== undefined) args.action = req.action;
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
        message: { type: 'STRING', description: "Alice's reply. Empty string only when tool_call is set." },
        emotion: { type: 'STRING', enum: [...EMOTIONS], description: 'How Alice feels right now.' },
        relationship_delta: {
            type: 'INTEGER',
            description: '-3..+3: how strongly this interaction moves the bond. 0 for neutral smalltalk.',
        },
        memory_action: {
            type: 'OBJECT',
            nullable: true,
            description: 'Set to store or drop a durable fact about the user; null otherwise.',
            properties: {
                action: { type: 'STRING', enum: ['remember', 'forget'] },
                text: { type: 'STRING', description: 'One-sentence fact to remember, or the exact memory to forget.' },
            },
            required: ['action', 'text'],
        },
        tool_call: {
            type: 'OBJECT',
            nullable: true,
            description: 'Set to invoke a tool instead of replying yet; null once done or not needed. Include only the fields the named tool needs.',
            properties: {
                name: { type: 'STRING', enum: [...TOOL_NAMES] },
                query: { type: 'STRING', description: 'web_search ONLY: short, focused search query.' },
                target: { type: 'STRING', description: 'dm_user / ignore_user ONLY: Discord mention (<@userID>) of the person being messaged or targeted. Omit to target the person you are currently talking to.' },
                message: { type: 'STRING', description: 'dm_user ONLY: the private message to send, in your own voice.' },
                action: { type: 'STRING', enum: ['ignore', 'unignore'], description: 'ignore_user ONLY: your own call — ignore stops your replies to them for ~24h, unignore allows replies again.' },
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
