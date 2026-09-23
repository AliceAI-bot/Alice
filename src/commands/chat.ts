import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    ChannelType,
    PermissionsBitField,
} from 'discord.js';
import { Guilds } from '../db/database.js';
import { getAvailablePersonas } from '../utils/personaLoader.js';
import { isVoter } from '../utils/voterCheck.js';
import { baseEmbed, EMBED_COLORS as COLORS } from '../utils/embeds.js';
import type { Command } from '../types/index.js';

const createEmbed = baseEmbed;

function checkAdminPerms(interaction: ChatInputCommandInteraction): boolean {
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
}

/** Shared persona validation for enable/update. Returns the persona or null after replying. */
async function resolvePersona(interaction: ChatInputCommandInteraction): Promise<string | null> {
    const persona = interaction.options.getString('personality') ?? '';
    const personas = await getAvailablePersonas();
    if (!personas.length) {
        await interaction.editReply({
            embeds: [createEmbed(interaction, '❌ No Personas Installed', '```md\n# No persona files found\n> Expected: src/ai/instructions/Persona/*.txt\n```', COLORS.error)],
        });
        return null;
    }
    if (!persona || !personas.includes(persona)) {
        const available = personas.map((p) => '`' + p + '`').join(', ');
        await interaction.editReply({
            embeds: [createEmbed(interaction, '❌ Invalid Persona', '```md\n# `' + (persona || '(none)') + '` is not a valid persona\n\nAvailable: ' + available + '\n```', COLORS.error)],
        });
        return null;
    }
    return persona;
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
        const gate = await isVoter(interaction.user.id, 'the /chat command', interaction.client.user?.id);
        if (gate) {
            await interaction.reply({ ...gate, flags: 64 }).catch(() => null);
            return;
        }

        if (!checkAdminPerms(interaction)) {
            await interaction.reply({
                embeds: [createEmbed(interaction, '❌ Permission Denied', '```md\n# Requires ManageChannels permission\n```', COLORS.error)],
                flags: 64,
            });
            return;
        }

        if (!interaction.guildId) {
            await interaction.reply({
                embeds: [createEmbed(interaction, '❌ Server Only', '```md\n# This command only works in a server\n```', COLORS.error)],
                flags: 64,
            });
            return;
        }

        await interaction.deferReply({ flags: 64 });

        const action = interaction.options.getString('action', true);
        const channel = interaction.options.getChannel('channel', true);
        const guildId = interaction.guildId;

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
            let personas: string[] = [];
            try {
                personas = await getAvailablePersonas();
            } catch {
                personas = [];
            }
            const filtered = personas
                .filter(p => p.toLowerCase().includes(focused.value.toLowerCase()))
                .slice(0, 25)
                .map(p => ({ name: p.charAt(0).toUpperCase() + p.slice(1), value: p }));
            await interaction.respond(filtered).catch(() => null);
        }
    },
} as Command;

async function handleEnable(interaction: ChatInputCommandInteraction, guildId: string, channelId: string): Promise<void> {
    const persona = await resolvePersona(interaction);
    if (!persona) return;

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
    const persona = await resolvePersona(interaction);
    if (!persona) return;

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