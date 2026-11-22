import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    type ButtonInteraction,
    type ChatInputCommandInteraction,
    type ModalSubmitInteraction,
    type Client,
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

export function voteRow(botId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        linkButton('⭐ Vote on Top.gg', `https://top.gg/bot/${botId}/vote`, '⭐'),
    );
}

/** Bot-initiated embeds brand themselves with the bot avatar (not a requester footer). */
function selfBranded(client: Client | null, color: number, title: string, description: string): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setFooter({ text: 'Alice • Automated notice' })
        .setTimestamp();
    const avatar = client?.user?.displayAvatarURL();
    if (avatar) embed.setThumbnail(avatar);
    return embed;
}

/** Service failure surfaced to the user — raw provider errors never leave logs. */
export function errorEmbed(client: Client | null, byok = false): EmbedBuilder {
    const tip = byok
        ? 'Your API key may be rate limited — try again shortly.'
        : 'Use `/byok` to add your own Gemini API key and skip the shared queue.';
    return selfBranded(
        client,
        EMBED_COLORS.error,
        '⚠️ Response Unavailable',
        `I'm having trouble processing your message right now. Please try again in a moment.\n\n💡 **Tip:** ${tip}`,
    );
}

/** Daily quota wall — still nudges voting for the bonus. */
export function quotaEmbed(
    client: Client | null,
    quota: number,
    bonus: number,
): { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = selfBranded(
        client,
        EMBED_COLORS.warning,
        '🌙 Daily Limit Reached',
        `\`\`\`md\n# Daily Limit Reached\n> Messages used today: ${quota}\n> Vote for Alice to receive +${bonus} bonus messages\n\`\`\`\nVotes unlock extra messages — your limit resets tomorrow.`,
    );
    const botId = client?.user?.id;
    return { embed, components: botId ? [voteRow(botId)] : [] };
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
