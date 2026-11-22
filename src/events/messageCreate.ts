import { Collection, Events, Message, MessageReplyOptions, PermissionsBitField } from 'discord.js';
import type { Attachment, User } from 'discord.js';
import type { CustomClient } from '../bot/client.js';
import { Guilds, Users } from '../db/database.js';
import { processMessage } from '../ai/processor.js';
import { cooldownLine } from '../ai/voiceLines.js';
import { createTosEmbed } from '../utils/tos.js';
import type { Event } from '../types/index.js';

const AI_COOLDOWN_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Rapid-fire batching: single messages send instantly (snappy). If the user spams
// while a generation is still running, follow-ups buffer and merge into ONE next
// turn instead of N separate LLM calls. Zero added latency for normal chat.
const inflight = new Set<string>();
const pendingBatches = new Map<string, Message[]>();

function batchKeyFor(message: Message): string {
    return `${message.author.id}:${message.channelId}`;
}

function drainPending(key: string): Message[] {
    const arr = pendingBatches.get(key) ?? [];
    pendingBatches.delete(key);
    return arr;
}

/**
 * Merge rapid-fire follow-ups into one turn: combined text + union of image
 * attachments (max 2, in order) + union of mentioned users, so the model sees
 * everything and tools resolve targets correctly. Replies in the latest
 * message's context.
 */
function mergeQueued(queued: Message[]): { message: Message; channel: Message['channel'] } | null {
    const last = queued[queued.length - 1]!;
    const combined = queued
        .map((m) => m.content.trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000);
    if (!combined) return null;

    const attachments = new Collection<string, Attachment>();
    for (const m of queued) {
        for (const att of m.attachments.values()) {
            if (attachments.size >= 2) break;
            if (att.contentType?.startsWith('image/')) attachments.set(att.id, att);
        }
        if (attachments.size >= 2) break;
    }

    const users = new Collection<string, User>();
    for (const m of queued) {
        for (const [id, u] of m.mentions.users) {
            if (!users.has(id)) users.set(id, u);
        }
    }

    const merged = Object.create(last, {
        content: { value: combined, writable: true },
        attachments: { value: attachments, writable: true },
        mentions: { value: { ...last.mentions, users }, writable: true },
    }) as Message;
    return { message: merged, channel: last.channel };
}

// Errors that mean "this channel was never going to accept our message" —
// dropping them silently is correct, a stack trace per occurrence is not.
const BENIGN_SEND_ERROR_CODES = new Set<string | number>([
    'ChannelNotCached',
    10003, // Unknown Channel
    50001, // Missing Access
    50013, // Missing Permissions
    50035, // Invalid Form Body (e.g. replying to system messages)
    50083, // Thread locked/archived
]);

function isBenignSendError(err: unknown): boolean {
    const code = (err as { code?: string | number } | undefined)?.code;
    return code !== undefined && BENIGN_SEND_ERROR_CODES.has(code);
}

async function safeReply(message: Message, content: string | MessageReplyOptions): Promise<void> {
    try {
        await message.reply(content);
    } catch (err) {
        if (!isBenignSendError(err)) throw err;
    }
}

function startTyping(channel: Message['channel']): () => void {
    if (!('sendTyping' in channel)) return () => {};

    let stopped = false;
    const send = () => {
        if (!stopped) (channel as { sendTyping: () => Promise<unknown> }).sendTyping().catch(() => null);
    };

    send();
    const interval = setInterval(send, 8000);

    return () => {
        stopped = true;
        clearInterval(interval);
    };
}

export default {
    name: Events.MessageCreate,
    async execute(message: Message, client: CustomClient): Promise<void> {
        if (!message.author || message.author.bot || message.system) return;
        if (message.author.id === client.user?.id) return;
        if (message.content.startsWith(',')) return;
        let channel = message.channel;
        if (!channel) {
            const fetched = await client.channels.fetch(message.channelId).catch(() => null);
            if (!fetched?.isTextBased()) return;
            channel = fetched;
        }
        if (!channel.isSendable()) return;

        const isDM = channel.isDMBased();

        if (!isDM) {
            // Skip early when we can't talk here anyway — avoids wasted lookups
            // and the Missing Permissions spam.
            const perms = message.guild?.members.me && 'permissionsFor' in channel
                ? channel.permissionsFor(message.guild.members.me)
                : null;
            if (
                !perms?.has([
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                ])
            ) {
                return;
            }
        }

        const clientId = client.user?.id;
        const mentioned = Boolean(clientId && message.mentions.has(clientId, { ignoreEveryone: true }));
        // Threads inherit the parent channel's config — otherwise threads in an
        // enabled channel always require a mention.
        const threadParent = (channel as { isThread?: () => boolean; parentId?: string | null }).isThread?.()
            ? ((channel as { parentId?: string | null }).parentId ?? null)
            : null;
        const personaChannelId = threadParent ?? message.channelId;
        const persona =
            isDM || !message.guildId ? null : await Guilds.getChannel(message.guildId, personaChannelId);
        if (!isDM && persona === null && !mentioned) return;

        const key = batchKeyFor(message);
        if (inflight.has(key)) {
            const arr = pendingBatches.get(key) ?? [];
            arr.push(message);
            pendingBatches.set(key, arr);
            return;
        }
        inflight.add(key);
        try {
            await handleTurn(message, client, channel, persona, true);
            // Drain any rapid-fire follow-ups that landed mid-generation as one merged turn.
            for (;;) {
                const queued = drainPending(key);
                if (!queued.length) break;
                try {
                    const merged = mergeQueued(queued);
                    if (!merged) continue;
                    // Config may have changed mid-generation — re-resolve per turn.
                    const freshPersona =
                        isDM || !message.guildId
                            ? null
                            : await Guilds.getChannel(message.guildId, personaChannelId).catch(() => persona);
                    await handleTurn(merged.message, client, merged.channel, freshPersona, false);
                } catch {
                    // Never drop user messages: re-queue leftovers for the next turn.
                    const leftover = drainPending(key);
                    pendingBatches.set(key, [...queued, ...leftover]);
                    break;
                }
            }
        } finally {
            pendingBatches.delete(key);
            inflight.delete(key);
        }
    },
} as Event;

async function handleTurn(
    message: Message,
    client: CustomClient,
    channel: Message['channel'],
    persona: string | null,
    checkCooldown: boolean,
): Promise<void> {
    const cooldownKey = `${message.author.id}:ai`;
    if (checkCooldown) {
        const now = Date.now();
        const expirationTime = client.cooldowns.get(cooldownKey);
        if (expirationTime && now < expirationTime) {
            await safeReply(message, cooldownLine());
            return;
        }
        // Set below only after a real reply — ToS blocks, blacklists and
        // failures must not consume the user's cooldown.
    }

    try {
        // ToS wall for AI chat: first-timers must accept before Alice replies
        // (slash commands already gate this; DMs/mentions previously bypassed it).
        try {
            const gate = await Users.getGateData(message.author.id);
            if (!gate.accepted) {
                const tos = createTosEmbed();
                await message.reply({ ...tos }).catch(() => safeReply(message, 'hey, accept my tos first — check the links above [happy]'));
                return;
            }
            if (gate.blacklisted) return;
        } catch {
            // Gate lookup failed — fall through to normal processing.
        }
        const response = await processMessage(message, persona, {
            onThinking: () => startTyping(channel),
        });
        if (!response) return;
        client.cooldowns.set(cooldownKey, Date.now() + AI_COOLDOWN_MS);

        // Embed replies (error / quota walls) skip the human-typing illusion.
        if (response.embed?.data) {
            await safeReply(message, {
                embeds: [response.embed],
                // exactOptionalPropertyTypes: only set components when present.
                ...(response.components ? { components: response.components } : {}),
            });
            return;
        }
        if (!response.content) return;

        // Tiny human jitter — stays snappy (300-900ms), just enough to feel typed.
        await sleep(300 + Math.random() * 600);
        await safeReply(message, response.content);
    } catch (err) {
        if (!isBenignSendError(err)) console.error('Message processing error:', err);
    }
}
