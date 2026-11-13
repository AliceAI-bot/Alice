import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    TextChannel,
    type Client,
} from 'discord.js';
import { Users } from '../db/database.js';
import { getLogChannel } from '../config/config.js';

export const APPEAL_URL = 'https://discord.gg/JypKEEqPfT';

interface BlacklistResponse {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
}

export function buildBlacklistResponse(reason: string, client?: Client): BlacklistResponse {
    const embed = new EmbedBuilder()
        .setTitle('🌸 Access Restricted')
        .setColor(0xffb7e1)
        .setDescription(
            '```md\n' +
            '# Sorry, you can\'t use Alice right now!\n' +
            'Your access has been *suspended* due to:\n' +
            `> **${reason}**\n` +
            '```\n' +
            'If you think this is a mistake, you can appeal below! 💌'
        )
        .setFooter({
            text: 'Alice • Appeal if you believe this is an error',
            ...(client?.user ? { iconURL: client.user.displayAvatarURL() } : {}),
        });

    const appealButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setLabel('✨ Appeal Suspension ✨')
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.gg/tqrVhMaUt')
    );

    return {
        embeds: [embed],
        components: [appealButton],
    };
}

export interface BlacklistRequest {
    client: Client;
    userId: string;
    reason: string;
    moderatorTag: string;
    moderatorId: string;
}

export interface BlacklistOutcome {
    /** false when the user was already blacklisted — nothing changed. */
    added: boolean;
    /** Existing reason/conflict when the user was already blacklisted. */
    existingReason?: string | null;
}

/**
 * Shared blacklist pipeline used by /operation and the flagged-content button:
 * gate check -> DB write -> channel log -> DM the user. Never throws for
 * logging/DM issues — only the DB write can propagate.
 */
export async function blacklistUser(req: BlacklistRequest): Promise<BlacklistOutcome> {
    const gate = await Users.getGateData(req.userId);
    if (gate.blacklisted) {
        return { added: false, existingReason: gate.reason };
    }

    // blacklist() throws for never-seen users — ensure the doc first.
    await Users.ensure(req.userId);
    await Users.blacklist(req.userId, req.reason);

    const logChannelId = getLogChannel('blacklist');
    if (logChannelId) {
        try {
            const ch = await req.client.channels.fetch(logChannelId);
            if (ch instanceof TextChannel) {
                const tag = await req.client.users.fetch(req.userId).then((u) => u.tag).catch(() => 'Unknown User');
                await ch.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('⛔ User Blacklisted')
                            .setDescription(
                                '```md\n' +
                                `# User Information\n> ID: ${req.userId}\n> Tag: ${tag}\n\n` +
                                `# Reason\n> ${req.reason}\n\n` +
                                `# Moderator\n> ${req.moderatorTag} (${req.moderatorId})\n` +
                                '```'
                            )
                            .setColor(0xff6f91)
                            .setTimestamp()
                            .setFooter({ text: 'Alice Blacklist Logs' }),
                    ],
                });
            }
        } catch {
            // Logging must never fail the action.
        }
    }

    try {
        const user = await req.client.users.fetch(req.userId);
        await user.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle('🚫 Blacklisted!')
                    .setDescription(
                        '```md\n' +
                        `# Oh no! You've been blacklisted from Alice.\n> Reason: ${req.reason}\n---\nWant to appeal? Click the button below or join the support server.\n` +
                        '```'
                    )
                    .setColor(0xffb6c1)
                    .setThumbnail(req.client.user?.displayAvatarURL() || null),
            ],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setLabel('✨ Appeal / Support ✨').setStyle(ButtonStyle.Link).setURL(APPEAL_URL)
                ),
            ],
        });
    } catch {
        // Closed DMs are not fatal.
    }

    return { added: true };
}
