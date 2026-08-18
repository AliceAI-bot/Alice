import { Message } from 'discord.js';
import { Guilds } from '../db/database.js';
import { decrypt } from '../integrations/crypto.js';

export async function shouldReply(message: Message): Promise<boolean> {
    if (!message.guild) return true;
    if (message.mentions.users.has(message.client.user!.id)) return true;

    const guild = await Guilds.get(message.guild!.id);
    if (!guild) return false;

    for (const config of Object.values(guild.channels)) {
        try {
            const channelId = decrypt(config.channelId);
            if (channelId === message.channelId) return true;
        } catch {
            // skip corrupted
        }
    }
    return false;
}