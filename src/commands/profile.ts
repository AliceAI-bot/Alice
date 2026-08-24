import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { Users } from '../db/database.js';
import { getUserState, usageToday } from '../db/redisStore.js';
import { checkVoteCached } from '../utils/voterCheck.js';
import { RELATIONSHIP_CONFIG } from '../config/relationshipConfig.js';
import { roundAffection } from '../utils/relationship.js';
import { getBadge } from '../config/config.js';
import type { Command } from '../types/index.js';

const COLORS = {
    primary: 0xFFD700,
    pink: 0xFFB6C1,
    error: 0xFF4444,
};

const MAX_FIELD_LENGTH = 1024;

function formatDate(timestamp: number | null | undefined): string {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}

function prettyStatus(status: string): string {
    return status
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function fitField(value: string): string {
    return value.length <= MAX_FIELD_LENGTH ? value : `${value.slice(0, MAX_FIELD_LENGTH - 1)}…`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription("View your or another user's profile")
        .addUserOption((option) =>
            option
                .setName('user')
                .setDescription('The user to view (leave empty for your own profile)')
                .setRequired(false),
        ),

    global: true,
    cooldown: 5,

    execute: async (interaction: ChatInputCommandInteraction): Promise<void> => {
        await interaction.deferReply();

        const targetUser = interaction.options.getUser('user') ?? interaction.user;

        try {
            const memberTask = interaction.guild
                ? interaction.guild.members.fetch(targetUser.id).catch(() => null)
                : null;

            const [user, state, member] = await Promise.all([
                Users.get(targetUser.id),
                getUserState(targetUser.id),
                memberTask,
            ]);

            const hasVoted = await checkVoteCached(targetUser.id, state);
            const currentUsage = state.usage.day === usageToday() ? state.usage.count : 0;

            const premiumActive =
                user != null &&
                user.tier === 'premium' &&
                (!user.premiumExpiry || user.premiumExpiry > Date.now());

            const tierDisplay = premiumActive ? 'Premium' : user?.tier === 'byok' ? 'BYOK' : 'Free';

            let quota: number | string;
            if (user?.tier === 'byok') {
                quota = 'Unlimited';
            } else {
                const base = premiumActive ? RELATIONSHIP_CONFIG.usage.premium : RELATIONSHIP_CONFIG.usage.free;
                quota = base + (hasVoted ? RELATIONSHIP_CONFIG.usage.voterBonus : 0);
            }

            const rel = user?.relationship;
            const affection = roundAffection(rel?.affection ?? 0);

            const memories = user?.memories ?? [];
            const memoriesValue = memories.length
                ? fitField(memories.map((memory) => `• ${memory}`).join('\n'))
                : '> Nothing remembered yet';

            const badges = user?.badges ?? [];
            const badgesDisplay = badges.length
                ? badges
                      .map((name) => getBadge(name))
                      .filter((badge): badge is string => Boolean(badge))
                      .join('\n')
                : '> No badges earned yet';

            const embed = new EmbedBuilder()
                .setAuthor({
                    name: `${targetUser.username}'s Profile`,
                    iconURL: targetUser.displayAvatarURL(),
                })
                .setDescription(`\`\`\`md\n# ${targetUser.username}\n> ID: ${targetUser.id}\n\`\`\``)
                .addFields(
                    {
                        name: '📊 User Statistics',
                        value: [
                            '```ml',
                            `Tier         : ${tierDisplay}`,
                            `Vote Status  : ${hasVoted ? 'Voted' : 'Not Voted'}`,
                            `Boost Status : ${member?.premiumSinceTimestamp ? 'Boosting' : 'Not Boosting'}`,
                            `Daily Usage  : ${currentUsage} / ${quota}`,
                            ``,
                            `Relationship : ${prettyStatus(rel?.status ?? 'stranger')}`,
                            `Affection    : ${affection}`,
                            `Messages     : ${(user?.stats.messagesSent ?? 0).toLocaleString()}`,
                            `First Met    : ${formatDate(user?.stats.firstSeen)}`,
                            '```',
                        ].join('\n'),
                        inline: false,
                    },
                    {
                        name: '🧠 Memories',
                        value: memoriesValue,
                        inline: false,
                    },
                    {
                        name: '🎖️ Achievements',
                        value: badgesDisplay,
                        inline: false,
                    },
                )
                .setColor(premiumActive ? COLORS.primary : COLORS.pink)
                .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
                .setFooter({
                    text: `Requested by ${interaction.user.tag}`,
                    iconURL: interaction.user.displayAvatarURL(),
                })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error(`Profile command error (${targetUser.id}):`, err);

            const embed = new EmbedBuilder()
                .setTitle('❌ Error')
                .setDescription(
                    `\`\`\`md\n# Something went wrong\n> ${err instanceof Error ? err.message : 'Unknown error'}\n\`\`\``,
                )
                .setColor(COLORS.error);

            await interaction.editReply({ embeds: [embed] }).catch(() => null);
        }
    },
} as Command;
