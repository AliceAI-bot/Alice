import { SlashCommandBuilder, ChatInputCommandInteraction, ButtonStyle, ButtonBuilder, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import type { Command } from '../types/index.js';

export default {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Get invitation links for Alice!'),
    
    global: true,
    cooldown: 5,
    // just gave up halfway and used AI to complete the code cuz everything was similar lol
    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply();

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🌟 Invite Alice')
            .setDescription(
                '```md\n' +
                '# Hello there! (｀・ω・´)\n' +
                '> Click the buttons below to get started!\n' +
                '```'
            )
            .setThumbnail(interaction.client.user?.displayAvatarURL())
            .setTimestamp()
            .setFooter({
                text: `Requested by ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL(),
            });

        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel('Add to Server')
                    .setURL('https://discord.com/oauth2/authorize?client_id=1111646562687397928&permissions=140126800960&scope=bot')
                    .setEmoji('➕'),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel('Support Server')
                    .setURL('https://discord.gg/j2wh9ctD9N')
                    .setEmoji('💫'),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel('Vote on Top.gg')
                    .setURL('https://top.gg/bot/1111646562687397928#reviews')
                    .setEmoji('⭐')
            );

        await interaction.followUp({
            embeds: [embed],
            components: [row],
        });
    },
} as Command;