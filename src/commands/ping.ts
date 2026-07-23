import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types/index.js';

export default {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check if Alice is awake 💤'),
    global: true,
    cooldown: 5,
    execute: async (interaction: ChatInputCommandInteraction) => {
      const start = Date.now();
        await interaction.reply({
            content: '✨ *Alice stirs awake...*',
        });

        const latency = Date.now() - start;
        await interaction.editReply(
          `(≧◡≦) Ping-pong~! \n Latency is **${latency}**ms ✨ \n API Latency is **${Math.round(interaction.client.ws.ping)}**ms. Zoom zoom~! 🚀`
        );
    }
} as Command;