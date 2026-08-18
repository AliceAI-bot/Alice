import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    EmbedBuilder,
    ChannelType,
    PermissionsBitField,
} from 'discord.js';
import { Guilds } from '../db/database.js';
import { getAvailablePersonas } from '../utils/personaLoader.js'; import type { Command } from '../types/index.js';

const COLORS = {
    primary: 0xFFD700,
    success: 0x00FF88,
    error: 0xFF4444,
    warning: 0xFFAA00,
    info: 0xB7EFFF,
};
// things are not looking very sigma
function createEmbed(interaction: { client: ChatInputCommandInteraction['client']; user: ChatInputCommandInteraction['user'] }, title: string, description: string, color: number = COLORS.primary) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setThumbnail(interaction.client.user?.displayAvatarURL() ?? null)
        .setFooter({ 
            text: `Requested by ${interaction.user.tag}`,
            iconURL: interaction.user.displayAvatarURL() 
        });
}

function checkAdminPerms(interaction: ChatInputCommandInteraction): boolean {
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
}

export default {
    data: new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Manage AI chat channels and personas')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('Action to perform')
                .setRequired(true)
                .addChoices(
                    { name: 'Enable', value: 'enable' },
                    { name: 'Disable', value: 'disable' },
                    { name: 'Update', value: 'update' },
                )
        )
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('Channel to configure')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('personality')
                .setDescription('AI persona to use')
                .setAutocomplete(true)
                .setRequired(false)
        ),

    global: true,
    cooldown: 5,

    execute: async (interaction: ChatInputCommandInteraction): Promise<void> => {
        if (!checkAdminPerms(interaction)) {
            await interaction.reply({
                embeds: [createEmbed(interaction, '❌ Permission Denied', '```md\n# Requires ManageChannels permission\n```', COLORS.error)],
                flags: 64,
            });
            return;
        }

        await interaction.deferReply({ flags: 64 });

        const action = interaction.options.getString('action', true);
        const channel = interaction.options.getChannel('channel', true);
        const guildId = interaction.guildId!;

        try {
            switch (action) {
                case 'enable':
                    await handleEnable(interaction, guildId, channel.id);
                    break;
                case 'disable':
                    await handleDisable(interaction, guildId, channel.id);
                    break;
                case 'update':
                    await handleUpdate(interaction, guildId, channel.id);
                    break;
            }
        } catch (err: any) {
            await interaction.editReply({
                embeds: [createEmbed(interaction, '❌ Error', `\`\`\`md\n# An error occurred\n> ${err.message}\n\`\`\``, COLORS.error)],
            });
        }
    },

    autocomplete: async (interaction: AutocompleteInteraction): Promise<void> => {
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'personality') {
            const personas = await getAvailablePersonas();
            const filtered = personas
                .filter(p => p.toLowerCase().includes(focused.value.toLowerCase()))
                .slice(0, 25)
                .map(p => ({ name: p.charAt(0).toUpperCase() + p.slice(1), value: p }));
            await interaction.respond(filtered);
        }
    },
} as Command;

async function handleEnable(interaction: ChatInputCommandInteraction, guildId: string, channelId: string): Promise<void> {
    const persona = interaction.options.getString('personality', true);

    const personas = await getAvailablePersonas();
    if (!personas.includes(persona)) {
        const available = personas.map(p => '`' + p + '`').join(', ');
        await interaction.editReply({
            embeds: [createEmbed(interaction, '❌ Invalid Persona', '```md\n# `' + persona + '` is not a valid persona\n\nAvailable: ' + available + '\n```', COLORS.error)],
        });
        return;
    }

    const existing = await Guilds.getChannel(guildId, channelId);
    if (existing) {
        await interaction.editReply({
            embeds: [createEmbed(interaction, '⚠️ Already Enabled', `\`\`\`md\n# Channel already configured\n> Current persona: **${existing}**\n> Use \`/chat update\` to change\n\`\`\``, COLORS.warning)],
        });
        return;
    }

    await Guilds.setChannel(guildId, channelId, persona);

    const embed = createEmbed(interaction, '✅ Chat Enabled', `\`\`\`md\n# Channel Configuration\n> Channel: <#${channelId}>\n> Persona: **${persona}**\n\`\`\``, COLORS.success);

    await interaction.editReply({ embeds: [embed] });
}

async function handleUpdate(interaction: ChatInputCommandInteraction, guildId: string, channelId: string): Promise<void> {
    const persona = interaction.options.getString('personality', true);

    const personas = await getAvailablePersonas();
    if (!personas.includes(persona)) {
        const available = personas.map(p => '`' + p + '`').join(', ');
        await interaction.editReply({
            embeds: [createEmbed(interaction, '❌ Invalid Persona', '```md\n# `' + persona + '` is not a valid persona\n\nAvailable: ' + available + '\n```', COLORS.error)],
        });
        return;
    }

    const existing = await Guilds.getChannel(guildId, channelId);
    if (!existing) {
        await interaction.editReply({
            embeds: [createEmbed(interaction, '❌ Channel Not Configured', `\`\`\`md\n# <#${channelId}> is not configured\n> Use \`/chat enable\` to set up first\n\`\`\``, COLORS.error)],
        });
        return;
    }

    const previousPersona = existing;
    if (previousPersona === persona) {
        await interaction.editReply({
            embeds: [createEmbed(interaction, '⚠️ Same Persona', `\`\`\`md\n# Channel already uses \`${persona}\`\n> No changes made\n\`\`\``, COLORS.warning)],
        });
        return;
    }

    await Guilds.setChannel(guildId, channelId, persona);

    const embed = createEmbed(interaction, '✅ Personality Updated', `\`\`\`md\n# Channel: <#${channelId}>\n> Previous: **${previousPersona}**\n> Current: **${persona}**\n\`\`\``, COLORS.success);

    await interaction.editReply({ embeds: [embed] });
}

async function handleDisable(interaction: ChatInputCommandInteraction, guildId: string, channelId: string): Promise<void> {
    const existing = await Guilds.getChannel(guildId, channelId);
    if (!existing) {
        await interaction.editReply({
            embeds: [createEmbed(interaction, '❌ Channel Not Configured', `\`\`\`md\n# <#${channelId}> is not configured\n\`\`\``, COLORS.error)],
        });
        return;
    }

    await Guilds.removeChannel(guildId, channelId);

    const embed = createEmbed(interaction, '🚫 Chat Disabled', `\`\`\`md\n# Channel Removed\n> <#${channelId}> (was: **${existing}**)\n\`\`\``, COLORS.error);

    await interaction.editReply({ embeds: [embed] });
}