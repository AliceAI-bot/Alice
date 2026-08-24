import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { isVoter } from '../utils/voterCheck.js';
import { resetSession, sessionKey } from '../db/redisStore.js';

export default {
    data: new SlashCommandBuilder()
        .setName('reset_session')
        .setDescription("Reset the current channel's chat session"),

    global: true,
    cooldown: 10,

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const gate = await isVoter(interaction.user.id, 'the session reset command');
        if (gate) {
            await interaction.reply({ ...gate, flags: 64 }).catch(() => null);
            return;
        }

        const isDM = interaction.channel?.isDMBased() ?? false;
        const key = sessionKey(isDM ? null : interaction.guildId, interaction.channelId);
        await resetSession(key);

        const embed = new EmbedBuilder()
            .setColor('Gold')
            .setTitle('🧹 Session Reset')
            .setDescription(
                '```md\n' +
                    '# Your chat session has been reset\n' +
                    '> All stored messages cleared\n' +
                    '> Session timer restarted (3 hours)\n' +
                    '```',
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] }).catch(() => null);
    },
} as Command;