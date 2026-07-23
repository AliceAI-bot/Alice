import { Message } from 'discord.js';
import { Channels } from '../db/database.js';

export async function shouldReply(message: Message): Promise<boolean> {
    // DMs always allowed
    if (!message.guild) return true;

    // Bot mentioned? Always allow
    if (message.mentions.users.has(message.client.user!.id)) return true;

    // Check if channel has AI enabled
    const channel = await Channels.get(message.channelId);
    return channel !== null;
}