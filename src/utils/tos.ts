import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageComponentInteraction } from 'discord.js';
import { Users } from '../db/database.js';

export async function ensureTos(userId: string): Promise<boolean> {
    const user = await Users.get(userId);
    return user !== null;
}

export function createTosEmbed(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('Terms of Service & Privacy Policy')
        .setDescription(
            'Before using Alice, please review and accept our policies:\n\n' +
            '• [Terms and Conditions](https://github.com/AliceBotTeam/Alice-Terms)\n' +
            '• [Privacy Policy](https://github.com/AliceBotTeam/Alice-Privacy)\n\n' +
            'By clicking **Agree and Continue**, you acknowledge and accept the terms above.'
        );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('accept_tos')
            .setLabel('Agree and Continue')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
        new ButtonBuilder()
            .setCustomId('cancel_tos')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );

    return { embeds: [embed], components: [row] };
}

export async function handleTosButton(interaction: MessageComponentInteraction): Promise<void> {
    if (interaction.customId === 'accept_tos') {
        await Users.ensure(interaction.user.id);
        await interaction.update({
            content: '✅ Thanks for accepting! You can now use Alice.',
            embeds: [],
            components: [],
        });
        setTimeout(() => interaction.deleteReply().catch(() => null), 5000);
        return;
    }

    if (interaction.customId === 'cancel_tos') {
        await interaction.update({
            content: '❌ You must accept the Terms of Service to use Alice.',
            embeds: [],
            components: [],
        });
        setTimeout(() => interaction.deleteReply().catch(() => null), 5000);
        return;
    }
}