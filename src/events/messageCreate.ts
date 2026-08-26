import { Events, Message, PermissionsBitField } from 'discord.js';
import type { CustomClient } from '../bot/client.js';
import { Guilds } from '../db/database.js';
import { processMessage } from '../ai/processor.js';
import type { Event } from '../types/index.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const AI_COOLDOWN_MS = 3000;

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

async function safeReply(message: Message, content: string): Promise<void> {
    try {
        await message.reply(content);
    } catch (err) {
        if (!isBenignSendError(err)) throw err;
    }
}

function splitMessage(content: string): string[] {
    if (content.length <= DISCORD_MESSAGE_LIMIT) return [content];

    const parts: string[] = [];
    let remaining = content;
    while (remaining.length > DISCORD_MESSAGE_LIMIT) {
        const window = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
        let cut = window.lastIndexOf('\n');
        if (cut <= 0) cut = window.lastIndexOf(' ');
        if (cut <= 0) cut = DISCORD_MESSAGE_LIMIT;

        parts.push(remaining.slice(0, cut).trimEnd());
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.length) parts.push(remaining);
    return parts;
}

function startTyping(channel: Message['channel']): () => void {
    if (!channel || !('sendTyping' in channel)) return () => {};

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

        // The channel cache can evict entries between event dispatch and our
        // reply (12k-guild scale), leaving Message#channel null.
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
        const mentioned = Boolean(clientId && message.mentions.has(clientId));
        const persona =
            isDM || !message.guildId ? null : await Guilds.getChannel(message.guildId, message.channelId);
        if (!isDM && persona === null && !mentioned) return;

        const cooldownKey = `${message.author.id}:ai`;
        const now = Date.now();
        const expirationTime = client.cooldowns.get(cooldownKey);
        if (expirationTime && now < expirationTime) {
            await safeReply(
                message,
                'Please slow down a bit — give me a few seconds before sending another message.',
            );
            return;
        }
        client.cooldowns.set(cooldownKey, now + AI_COOLDOWN_MS);

        try {
            const response = await processMessage(message, persona, {
                onThinking: () => startTyping(channel),
            });
            if (!response?.content) return;

            const parts = splitMessage(response.content);
            await safeReply(message, parts[0]!);
            for (const part of parts.slice(1)) {
                try {
                    await channel.send(part);
                } catch (err) {
                    if (!isBenignSendError(err)) throw err;
                    break;
                }
            }
        } catch (err) {
            if (!isBenignSendError(err)) console.error('Message processing error:', err);
        }
    },
} as Event;
