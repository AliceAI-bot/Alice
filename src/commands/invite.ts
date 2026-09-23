import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types/index.js';
import { baseEmbed, inviteRow } from '../utils/embeds.js';

export default {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Get invitation links for Alice!'),
    
    global: true,
    cooldown: 5,
    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply();

        const botId = interaction.client.user?.id ?? '';

        const embed = baseEmbed(
            interaction,
            '🌟 Invite Alice',
            '```md\n# Hello there! (｀・ω・´)\n> Click the buttons below to get started!\n```',
        );

        await interaction.followUp({
            embeds: [embed],
            components: [inviteRow(botId)],
        });
    },
} as Command;