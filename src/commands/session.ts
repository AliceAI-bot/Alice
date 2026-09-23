import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { isVoter } from '../utils/voterCheck.js';
import { getSession, resetSession, sessionKey } from '../db/redisStore.js';
import { baseEmbed } from '../utils/embeds.js';

export default {
    data: new SlashCommandBuilder()
        .setName('reset_session')
        .setDescription("Reset the current channel's chat session"),

    global: true,
    cooldown: 10,

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const isDM = interaction.channel?.isDMBased() ?? false;
        const key = sessionKey(isDM ? null : interaction.guildId, interaction.channelId);

        // Only session participants may wipe the shared session. An empty
        // session has nothing to grief, so it passes through.
        let participant = false;
        try {
            const session = await getSession(key);
            participant = session.length === 0 || session.some((m) => m.authorId === interaction.user.id);
        } catch {
            await interaction.reply({
                embeds: [baseEmbed(interaction, '❌ Error', '```md\n# Could not check the session\n> Try again in a moment\n```', 0xff4444)],
                flags: 64,
            }).catch(() => null);
            return;
        }
        if (!participant) {
            await interaction.reply({
                embeds: [baseEmbed(interaction, '🚫 Not Your Session', '```md\n# Only session participants can reset it\n> Join the conversation first\n```', 0xff4444)],
                flags: 64,
            }).catch(() => null);
            return;
        }

        const gate = await isVoter(interaction.user.id, 'the session reset command', interaction.client.user?.id);
        if (gate) {
            await interaction.reply({ ...gate, flags: 64 }).catch(() => null);
            return;
        }

        await resetSession(key);

        const embed = baseEmbed(
            interaction,
            '🧹 Session Reset',
            '```md\n# Your chat session has been reset\n> All stored messages cleared\n> Session timer restarted (3 hours)\n```',
        );

        await interaction.reply({ embeds: [embed] }).catch(() => null);
    },
} as Command;