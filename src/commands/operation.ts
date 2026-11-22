import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction, TextChannel, type Client } from 'discord.js';
import { Users } from '../db/database.js';
import { isOwner, isModerator, getLogChannel, getBadge } from '../config/config.js';
import { baseEmbed } from '../utils/embeds.js';
import { blacklistUser } from '../utils/blacklistUtil.js';
import type { Command } from '../types/index.js';

export default {
    data: new SlashCommandBuilder()
        .setName('operation')
        .setDescription('Mod/Dev operations: manage blacklist, premium, and badges')
        .addStringOption(opt =>
            opt.setName('mode')
                .setDescription('Operation mode')
                .setRequired(true)
                .addChoices(
                    { name: '🚫 Blacklist', value: 'blacklist' },
                    { name: '✨ Premium', value: 'premium' },
                    { name: '🎖️ Badge', value: 'badge' }
                )
        )
        .addStringOption(opt =>
            opt.setName('action')
                .setDescription('Action to perform')
                .setRequired(true)
                .addChoices(
                    { name: 'Add', value: 'add' },
                    { name: 'Remove', value: 'remove' },
                    { name: 'Check', value: 'check' }
                )
        )
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Target user')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('reason')
                .setDescription('[Blacklist] Reason for blacklist')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('badge')
                .setDescription('[Badge] Badge name to add/remove')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('expiry')
                .setDescription('[Premium] Expiry date (YYYY-MM-DD)')
                .setRequired(false)
        ),

    global: false,
    cooldown: 5,

    execute: async (interaction: ChatInputCommandInteraction): Promise<void> => {
        const mode = interaction.options.getString('mode', true);
        const action = interaction.options.getString('action', true);
        const userId = interaction.options.getUser('user', true).id;

        const executorId = String(interaction.user.id);
        const ownerCheck = isOwner(executorId);
        const modCheck = isModerator(executorId);

        if (mode === 'badge' && !ownerCheck) {
            await interaction.reply({
                embeds: [embed(interaction, '🚫 Developer Only', '# Access Denied\n> This operation is reserved for bot developers.', 0xff6b6b)],
                flags: 64,
            });
            return;
        }

        if ((mode === 'blacklist' || mode === 'premium') && !modCheck && !ownerCheck) {
            await interaction.reply({
                embeds: [embed(interaction, '🚫 No Access!', '# Sorry, cutie!\n> You need to be a bot owner or moderator to use this command.', 0xffb6c1)],
                flags: 64,
            });
            return;
        }

        await interaction.deferReply({ flags: 64 });

        try {
            switch (mode) {
                case 'blacklist': await handleBlacklist(interaction, action, userId); break;
                case 'premium': await handlePremium(interaction, action, userId); break;
                case 'badge': await handleBadge(interaction, action, userId); break;
                default:
                    await interaction.editReply({ embeds: [embed(interaction, '❌ Invalid Mode', 'Invalid mode specified.', 0xff0000)] });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await interaction.editReply({ embeds: [embed(interaction, '❌ Error', `An error occurred: \`${message}\``, 0xff0000)] });
        }
    },
} as Command;

const embed = (interaction: ChatInputCommandInteraction, title: string, desc: string, color: number) =>
    baseEmbed(interaction, title, '```md\n' + desc + '\n```', color);

/** Badge replies + the premium log share this one-off shape (no ```md wrapper). */
const styledEmbed = (title: string, description: string, color: number, footer?: string): EmbedBuilder => {
    const styled = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
    return footer ? styled.setFooter({ text: footer }) : styled;
};

async function fetchTag(client: Client, id: string): Promise<string> {
    try {
        return (await client.users.fetch(id)).tag;
    } catch {
        return 'Unknown User';
    }
}

type ActionHandler = () => Promise<unknown>;

async function dispatchAction(
    interaction: ChatInputCommandInteraction,
    action: string,
    handlers: Record<string, ActionHandler>,
): Promise<void> {
    const handler = handlers[action];
    if (handler) {
        await handler();
        return;
    }
    await interaction.editReply({ embeds: [embed(interaction, '❌ Invalid Action', 'Invalid action specified.', 0xff0000)] });
}

async function handleBlacklist(interaction: ChatInputCommandInteraction, action: string, userId: string): Promise<void> {
    await dispatchAction(interaction, action, {
        add: () => blAdd(interaction, userId),
        remove: () => blRemove(interaction, userId),
        check: () => blCheck(interaction, userId),
    });
}

async function blAdd(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const reason = interaction.options.getString('reason') || 'No reason provided.';

    const outcome = await blacklistUser({
        client: interaction.client,
        userId,
        reason,
        moderatorTag: interaction.user.tag,
        moderatorId: interaction.user.id,
    });

    if (!outcome.added) {
        await interaction.editReply({
            embeds: [embed(interaction, '⚠️ Already Blacklisted', `# User <@${userId}> is already blacklisted.\n> Reason: ${outcome.existingReason || 'Unknown'}`, 0xffa500)],
        });
        return;
    }

    await interaction.editReply({ embeds: [embed(interaction, '✅ Blacklisted', `# <@${userId}> has been blacklisted.\n> Reason: ${reason}`, 0x00ff00)] });
}

async function blRemove(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const gate = await Users.getGateData(userId);
    if (!gate.blacklisted) {
        await interaction.editReply({ embeds: [embed(interaction, '⚠️ Not Blacklisted', `# <@${userId}> is not blacklisted.`, 0xffa500)] });
        return;
    }
    await Users.unblacklist(userId);
    await interaction.editReply({ embeds: [embed(interaction, '✅ Unblacklisted', `# <@${userId}> has been removed from the blacklist.`, 0x00ff00)] });
}

async function blCheck(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const gate = await Users.getGateData(userId);
    await interaction.editReply({
        embeds: [
            gate.blacklisted
                ? embed(interaction, '🚫 Blacklisted', `# <@${userId}> is blacklisted.\n> Reason: ${gate.reason || 'Unknown'}`, 0xff0000)
                : embed(interaction, '✅ Not Blacklisted', `# <@${userId}> is not blacklisted.`, 0x00ff00),
        ],
    });
}

async function handlePremium(interaction: ChatInputCommandInteraction, action: string, userId: string): Promise<void> {
    await dispatchAction(interaction, action, {
        add: () => prAdd(interaction, userId),
        remove: () => prRemove(interaction, userId),
        check: () => prCheck(interaction, userId),
    });
}

async function prAdd(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const expiryStr = interaction.options.getString('expiry');

    if (!expiryStr) {
        await interaction.editReply({ embeds: [embed(interaction, '❓ Missing Parameters', '# Premium add requires:\n> expiry: YYYY-MM-DD', 0xffa500)] });
        return;
    }

    const expiry = new Date(expiryStr);
    if (Number.isNaN(expiry.getTime())) {
        await interaction.editReply({ embeds: [embed(interaction, '❓ Invalid Expiry', '# Expiry must be a valid date (YYYY-MM-DD).', 0xffa500)] });
        return;
    }

    const existing = await Users.ensure(userId);
    await Users.update(userId, { tier: 'premium', premiumExpiry: expiry.getTime() }, existing);

    const logChannelId = getLogChannel('premium');
    if (logChannelId) {
        try {
            const ch = await interaction.client.channels.fetch(logChannelId);
            if (ch instanceof TextChannel) {
                await ch.send({
                    embeds: [
                        styledEmbed(
                            '✨ Premium Status Added',
                            '```md\n' +
                                `# User Information\n> ID: ${userId}\n> Tag: ${await fetchTag(interaction.client, userId)}\n\n` +
                                `# Premium Details\n> Expiry: ${expiryStr}\n\n` +
                                `# Moderator\n> ${interaction.user.tag} (${interaction.user.id})\n` +
                                '```',
                            0xffd700,
                            'Alice Premium Logs',
                        ),
                    ],
                });
            }
        } catch {
            // Logging must never fail the command.
        }
    }

    await interaction.editReply({ embeds: [embed(interaction, '✅ Premium Added', `# <@${userId}> now has premium!\n> Expires: ${expiryStr}`, 0x00ff00)] });
}

async function prRemove(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const user = await Users.get(userId);
    if (!user || user.tier !== 'premium') {
        await interaction.editReply({ embeds: [embed(interaction, '⚠️ Not Premium', `# <@${userId}> does not have premium.`, 0xffa500)] });
        return;
    }
    await Users.update(userId, { tier: 'free', premiumExpiry: null });
    await interaction.editReply({ embeds: [embed(interaction, '✅ Premium Removed', `# <@${userId}> has lost premium status.`, 0xffb6c1)] });
}

async function prCheck(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const user = await Users.get(userId);
    const isPremium = user?.tier === 'premium' && (!user.premiumExpiry || user.premiumExpiry > Date.now());
    const expiry = user?.premiumExpiry ? new Date(user.premiumExpiry).toISOString().split('T')[0] : 'N/A';

    await interaction.editReply({
        embeds: [embed(interaction, '✨ Premium Status', `# <@${userId}>\n> Premium: ${isPremium ? 'Active ✅' : 'Inactive ❌'}\n> Expires: ${isPremium ? expiry : 'N/A'}`, isPremium ? 0xffd700 : 0x808080)],
    });
}

async function handleBadge(interaction: ChatInputCommandInteraction, action: string, userId: string): Promise<void> {
    const badgeName = interaction.options.getString('badge');

    if (!badgeName) {
        await interaction.editReply({ embeds: [embed(interaction, '❓ Missing Badge', '# Please specify a badge to add or remove.', 0xffa500)] });
        return;
    }

    const badgeDisplay = getBadge(badgeName);
    if (!badgeDisplay) {
        await interaction.editReply({ embeds: [embed(interaction, '❓ Invalid Badge', `# Badge \`${badgeName}\` does not exist.`, 0xffa500)] });
        return;
    }

    await dispatchAction(interaction, action, {
        add: () => bgAdd(interaction, userId, badgeName, badgeDisplay),
        remove: () => bgRemove(interaction, userId, badgeName, badgeDisplay),
        check: () => bgCheck(interaction, userId),
    });
}

async function bgAdd(interaction: ChatInputCommandInteraction, userId: string, badgeName: string, badgeDisplay: string): Promise<void> {
    await Users.addBadge(userId, badgeName);
    await interaction.editReply({
        embeds: [
            styledEmbed(
                '🎖️ Badge Awarded!',
                `### Badge Added\n${badgeDisplay}\n\n🎯 Given to: <@${userId}>\n👤 By: <@${interaction.user.id}>`,
                0xffd700,
                'Alice Badge System',
            ),
        ],
    });
}

async function bgRemove(interaction: ChatInputCommandInteraction, userId: string, badgeName: string, badgeDisplay: string): Promise<void> {
    const user = await Users.get(userId);
    if (!user?.badges.includes(badgeName)) {
        await interaction.editReply({ embeds: [embed(interaction, '❓ No Badge', `# <@${userId}> does not have the \`${badgeName}\` badge.`, 0xffa500)] });
        return;
    }
    await Users.removeBadge(userId, badgeName);
    await interaction.editReply({
        embeds: [
            styledEmbed(
                '💫 Badge Removed',
                `### Badge Removed\n${badgeDisplay}\n\n🎯 Removed from: <@${userId}>\n👤 By: <@${interaction.user.id}>`,
                0xff6b6b,
                'Alice Badge System',
            ),
        ],
    });
}

async function bgCheck(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const user = await Users.get(userId);
    const badges = user?.badges ?? [];

    if (!badges.length) {
        await interaction.editReply({ embeds: [embed(interaction, '❓ No Badges', `# <@${userId}> has no badges.`, 0xffa500)] });
        return;
    }

    const badgeList = badges.map(b => getBadge(b) || b).join('\n');
    await interaction.editReply({
        embeds: [styledEmbed('🎖️ User Badges', `# <@${userId}>\n\n${badgeList}`, 0xffd700)],
    });
}
