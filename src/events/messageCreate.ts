import { Events, Message } from 'discord.js';
import type { CustomClient } from '../bot/client.js';
import { Guilds } from '../db/database.js';
import { processMessage } from '../ai/processor.js';
import type { Event } from '../types/index.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const AI_COOLDOWN_MS = 3000;

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

function startTyping(message: Message): () => void {
    const channel = message.channel;
    if (!('sendTyping' in channel)) return () => {};

    let stopped = false;
    const send = () => {
        if (!stopped) channel.sendTyping().catch(() => null);
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
        if (!message.author || message.author.bot) return;
        if (message.author.id === client.user?.id) return;

        const cooldownKey = `${message.author.id}:ai`;
        const now = Date.now();
        const expirationTime = client.cooldowns.get(cooldownKey);
        if (expirationTime && now < expirationTime) {
            await message
                .reply('Please slow down a bit — give me a few seconds before sending another message.')
                .catch(() => null);
            return;
        }
        client.cooldowns.set(cooldownKey, now + AI_COOLDOWN_MS);

        const clientId = client.user?.id;
        const isDM = message.channel.isDMBased();
        const persona =
            isDM || !message.guildId ? null : await Guilds.getChannel(message.guildId, message.channelId);
        const mentioned = Boolean(clientId && message.mentions.has(clientId));
        if (!isDM && persona === null && !mentioned) return;

        try {
            const response = await processMessage(message, persona, {
                onThinking: () => startTyping(message),
            });
            if (!response?.content) return;

            const parts = splitMessage(response.content);
            await message.reply(parts[0]!);
            if (!message.channel.isSendable()) return;
            for (const part of parts.slice(1)) {
                await message.channel.send(part);
            }
        } catch (err) {
            console.error('Message processing error:', err);
        }
    },
} as Event;
