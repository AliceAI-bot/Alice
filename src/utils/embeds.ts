import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    type ButtonInteraction,
    type ChatInputCommandInteraction,
    type ModalSubmitInteraction,
} from 'discord.js';

export const EMBED_COLORS = {
    primary: 0xffd700,
    success: 0x00ff88,
    error: 0xff4444,
    warning: 0xffaa00,
    info: 0xb7efff,
    pink: 0xffb6c1,
} as const;

type EmbedCtx = Pick<
    ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
    'client' | 'user'
>;

/** Single flagship style for command replies: title + md body + thumbnail + requester footer. */
export function baseEmbed(
    ctx: EmbedCtx,
    title: string,
    description: string,
    color: number = EMBED_COLORS.primary,
): EmbedBuilder {
    // discord.js rejects empty title/description — skip unset parts so callers
    // can fill them in afterwards.
    const embed = new EmbedBuilder()
        .setColor(color)
        .setThumbnail(ctx.client.user?.displayAvatarURL() ?? null)
        .setFooter({
            text: `Requested by ${ctx.user.tag}`,
            iconURL: ctx.user.displayAvatarURL(),
        })
        .setTimestamp();
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    return embed;
}

function linkButton(label: string, url: string, emoji: string): ButtonBuilder {
    return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url).setEmoji(emoji);
}

// NOTE: the support/appeal invites used by the blacklist flow are different
// links and stay where they are — this row is only the public invite set.
export function inviteRow(botId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        linkButton(
            'Add to Server',
            `https://discord.com/oauth2/authorize?client_id=${botId}&permissions=140126800960&scope=bot`,
            '➕',
        ),
        linkButton('Support Server', 'https://discord.gg/j2wh9ctD9N', '💫'),
        linkButton('Vote on Top.gg', `https://top.gg/bot/${botId}/vote`, '⭐'),
    );
}
