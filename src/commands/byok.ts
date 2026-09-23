import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
    ModalBuilder,
    ModalSubmitInteraction,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { Users } from '../db/database.js';
import { keycheck } from '../integrations/google.js';
import { baseEmbed, EMBED_COLORS as COLORS } from '../utils/embeds.js';
import type { Command } from '../types/index.js';

const INFO_DESCRIPTION = [
    '# Bring Your Own Key',
    '> Use your own Google Gemini API key with Alice instead of',
    '> the shared queue. more uptime for everyone.',
    '',
    '# How to get a key',
    '1. Go to https://aistudio.google.com/apikey',
    '2. Sign in with your Google account',
    '3. Click "Create API key" and copy it',
    '',
    '# Security',
    '> Your key is AES-256 encrypted before storage and is',
    '> ONLY used for your own requests. It is never shared.',
].join('\n');

const createEmbed = baseEmbed;

async function buildByokPayload(interaction: ChatInputCommandInteraction | ButtonInteraction, opts: { removed?: boolean } = {}) {
    const user = await Users.get(interaction.user.id);
    const hasKey = Boolean(user?.byokKey);

    const title = opts.removed ? '🗑️ Key Removed' : '🔑 Bring Your Own Key';
    const description = opts.removed
        ? '```md\n# Your Gemini API key has been removed.\n> The embed above has been reset.\n> Hit Add Your Key to connect a new one anytime.\n```'
        : '```md\n' + INFO_DESCRIPTION + '\n```';

    const embed = baseEmbed(interaction, title, description, opts.removed ? COLORS.success : COLORS.primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${hasKey ? 'byok_remove' : 'byok_add'}:${interaction.user.id}`)
            .setLabel(hasKey ? '🗑️ Remove Your Key' : '🔑 Add Your Key')
            .setStyle(hasKey ? ButtonStyle.Danger : ButtonStyle.Success)
    );

    return {
        embeds: [embed],
        components: [row],
    };
}

export default {
    data: new SlashCommandBuilder()
        .setName('byok')
        .setDescription('Bring Your Own Key — connect your Google Gemini API key to Alice'),

    global: true,
    cooldown: 5,

    execute: async (interaction: ChatInputCommandInteraction): Promise<void> => {
        await interaction.deferReply();
        const payload = await buildByokPayload(interaction);
        await interaction.editReply(payload);
    },
} as Command;

export async function handleByokButton(interaction: ButtonInteraction): Promise<void> {
    const [, authorId] = interaction.customId.split(':');

    if (authorId && authorId !== interaction.user.id) {
        await interaction.reply({
            content: 'This BYOK panel belongs to someone else — run `/byok` to manage your own key.',
            flags: 64,
        });
        return;
    }

    if (interaction.customId.startsWith('byok_add')) {
        const modal = new ModalBuilder()
            .setCustomId('byok_modal')
            .setTitle('🔑 Add Your Gemini Key')
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('byok_key')
                        .setLabel('Google AI Studio API Key')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setPlaceholder('AIza...')
                )
            );

        await interaction.showModal(modal);
        return;
    }

    if (interaction.customId.startsWith('byok_remove')) {
        await interaction.deferUpdate();
        // Removing a key must not strip paid premium.
        const existing = await Users.ensure(interaction.user.id);
        await Users.update(
            interaction.user.id,
            { tier: existing.tier === 'premium' ? 'premium' : 'free', byokKey: null },
            existing,
        );
        const payload = await buildByokPayload(interaction, { removed: true });
        await interaction.editReply(payload);
    }
}

export async function handleByokModal(interaction: ModalSubmitInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });

    const key = interaction.fields.getTextInputValue('byok_key').trim();

    const user = await Users.ensure(interaction.user.id);
    if (user?.byokKey) {
        await interaction.editReply({
            embeds: [createEmbed(interaction, '⚠️ Already Set', '```md\n# You already have a BYOK key saved.\n> Use /byok and hit Remove Key first if you want to change it.\n```', COLORS.warning)],
        });
        return;
    }

    const result = await keycheck(key);
    if (!result.valid) {
        await interaction.editReply({
            embeds: [createEmbed(interaction, '❌ Invalid Key', '```md\n# Could not verify your key.\n> ' + (result.error ?? 'Unknown error') + '\n```', COLORS.error)],
        });
        return;
    }

    await Users.update(interaction.user.id, { tier: 'byok', byokKey: key }, user);

    await interaction.editReply({
        embeds: [createEmbed(interaction, '✅ Key Saved', '```md\n# Your BYOK key is set and encrypted.\n> It will only be used for your requests. Enjoy!\n```', COLORS.success)],
    });
}