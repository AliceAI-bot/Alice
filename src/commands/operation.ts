import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { Users } from '../db/database.js';
import { isOwner, isModerator, getLogChannel, getBadge } from '../config/config.js';
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
        .addStringOption(opt =>
            opt.setName('userid')
                .setDescription('Target user ID')
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
        const userId = interaction.options.getString('userid', true);

        const executorId = String(interaction.user.id);
        const ownerCheck = isOwner(executorId);
        const modCheck = isModerator(executorId);

        if (mode === 'badge' && !ownerCheck) {
            await interaction.reply({
                embeds: [embed('🚫 Developer Only', '# Access Denied\n> This operation is reserved for bot developers.', 0xff6b6b)],
                flags: 64,
            });
            return;
        }

        if ((mode === 'blacklist' || mode === 'premium') && !modCheck && !ownerCheck) {
            await interaction.reply({
                embeds: [embed('🚫 No Access!', '# Sorry, cutie!\n> You need to be a bot owner or moderator to use this command.', 0xffb6c1)],
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
                    await interaction.editReply({ embeds: [embed('❌ Invalid Mode', 'Invalid mode specified.', 0xff0000)] });
            }
        } catch (err: any) {
            await interaction.editReply({ embeds: [embed('❌ Error', `An error occurred: \`${err.message}\``, 0xff0000)] });
        }
    },
} as Command;

const embed = (title: string, desc: string, color: number) =>
    new EmbedBuilder().setTitle(title).setDescription('```md\n' + desc + '\n```').setColor(color);

const fetchTag = (client: any, id: string) =>
    client.users.fetch(id).then((u: any) => u.tag).catch(() => 'Unknown User');

async function handleBlacklist(interaction: ChatInputCommandInteraction, action: string, userId: string) {
    switch (action) {
        case 'add': return await blAdd(interaction, userId);
        case 'remove': return await blRemove(interaction, userId);
        case 'check': return await blCheck(interaction, userId);
        default: return interaction.editReply({ embeds: [embed('❌ Invalid Action', 'Invalid action specified.', 0xff0000)] });
    }
}

async function blAdd(interaction: ChatInputCommandInteraction, userId: string) {
    const reason = interaction.options.getString('reason') || 'No reason provided.';

    if (await Users.isBlacklisted(userId)) {
        await interaction.editReply({
            embeds: [embed('⚠️ Already Blacklisted', `# User <@${userId}> is already blacklisted.\n> Reason: ${await Users.getBlacklistReason(userId) || 'Unknown'}`, 0xffa500)],
        });
        return;
    }

    await Users.blacklist(userId, reason);

    const logChannelId = getLogChannel('blacklist');
    if (logChannelId) {
        interaction.client.channels.fetch(logChannelId).then(async (ch) => {
            if (ch instanceof TextChannel) {
                await ch.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('⛔ User Blacklisted')
                            .setDescription(
                                '```md\n' +
                                `# User Information\n> ID: ${userId}\n> Tag: ${await fetchTag(interaction.client, userId)}\n\n` +
                                `# Reason\n> ${reason}\n\n` +
                                `# Moderator\n> ${interaction.user.tag} (${interaction.user.id})\n` +
                                '```'
                            )
                            .setColor(0xff6f91)
                            .setTimestamp()
                            .setFooter({ text: 'Alice Blacklist Logs' }),
                    ],
                });
            }
        }).catch(() => {});
    }

    interaction.client.users.fetch(userId).then(async (user) => {
        await user.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle('🚫 Blacklisted!')
                    .setDescription(
                        '```md\n' +
                        `# Oh no! You've been blacklisted from Alice.\n> Reason: ${reason}\n---\nWant to appeal? Click the button below or join the support server.\n` +
                        '```'
                    )
                    .setColor(0xffb6c1)
                    .setThumbnail(interaction.client.user?.displayAvatarURL() || null),
            ],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setLabel('✨ Appeal / Support ✨').setStyle(ButtonStyle.Link).setURL('https://discord.gg/JypKEEqPfT')
                ),
            ],
        });
    }).catch(() => {});

    await interaction.editReply({ embeds: [embed('✅ Blacklisted', `# <@${userId}> has been blacklisted.\n> Reason: ${reason}`, 0x00ff00)] });
}

async function blRemove(interaction: ChatInputCommandInteraction, userId: string) {
    if (!(await Users.isBlacklisted(userId))) {
        await interaction.editReply({ embeds: [embed('⚠️ Not Blacklisted', `# <@${userId}> is not blacklisted.`, 0xffa500)] });
        return;
    }
    await Users.unblacklist(userId);
    await interaction.editReply({ embeds: [embed('✅ Unblacklisted', `# <@${userId}> has been removed from the blacklist.`, 0x00ff00)] });
}

async function blCheck(interaction: ChatInputCommandInteraction, userId: string) {
    const isBl = await Users.isBlacklisted(userId);
    await interaction.editReply({
        embeds: [
            isBl
                ? embed('🚫 Blacklisted', `# <@${userId}> is blacklisted.\n> Reason: ${await Users.getBlacklistReason(userId) || 'Unknown'}`, 0xff0000)
                : embed('✅ Not Blacklisted', `# <@${userId}> is not blacklisted.`, 0x00ff00),
        ],
    });
}

async function handlePremium(interaction: ChatInputCommandInteraction, action: string, userId: string) {
    switch (action) {
        case 'add': return await prAdd(interaction, userId);
        case 'remove': return await prRemove(interaction, userId);
        case 'check': return await prCheck(interaction, userId);
        default: return interaction.editReply({ embeds: [embed('❌ Invalid Action', 'Invalid action specified.', 0xff0000)] });
    }
}

async function prAdd(interaction: ChatInputCommandInteraction, userId: string) {
    const expiryStr = interaction.options.getString('expiry');

    if (!expiryStr) {
        await interaction.editReply({ embeds: [embed('❓ Missing Parameters', '# Premium add requires:\n> expiry: YYYY-MM-DD', 0xffa500)] });
        return;
    }

    const expiry = new Date(expiryStr);
    if (isNaN(expiry.getTime())) {
        await interaction.editReply({ embeds: [embed('❓ Invalid Expiry', '# Expiry must be a valid date (YYYY-MM-DD).', 0xffa500)] });
        return;
    }

    await Users.update(userId, { tier: 'premium', premiumExpiry: expiry.getTime() });

    const logChannelId = getLogChannel('premium');
    if (logChannelId) {
        interaction.client.channels.fetch(logChannelId).then(async (ch) => {
            if (ch instanceof TextChannel) {
                await ch.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('✨ Premium Status Added')
                            .setDescription(
                                '```md\n' +
                                `# User Information\n> ID: ${userId}\n> Tag: ${await fetchTag(interaction.client, userId)}\n\n` +
                                `# Premium Details\n> Expiry: ${expiryStr}\n\n` +
                                `# Moderator\n> ${interaction.user.tag} (${interaction.user.id})\n` +
                                '```'
                            )
                            .setColor(0xffd700)
                            .setTimestamp()
                            .setFooter({ text: 'Alice Premium Logs' }),
                    ],
                });
            }
        }).catch(() => {});
    }

    await interaction.editReply({ embeds: [embed('✅ Premium Added', `# <@${userId}> now has premium!\n> Expires: ${expiryStr}`, 0x00ff00)] });
}

async function prRemove(interaction: ChatInputCommandInteraction, userId: string) {
    const user = await Users.get(userId);
    if (!user || user.tier !== 'premium') {
        await interaction.editReply({ embeds: [embed('⚠️ Not Premium', `# <@${userId}> does not have premium.`, 0xffa500)] });
        return;
    }
    await Users.update(userId, { tier: 'free', premiumExpiry: null });
    await interaction.editReply({ embeds: [embed('✅ Premium Removed', `# <@${userId}> has lost premium status.`, 0xffb6c1)] });
}

async function prCheck(interaction: ChatInputCommandInteraction, userId: string) {
    const user = await Users.get(userId);
    const isPremium = user?.tier === 'premium' && (!user.premiumExpiry || user.premiumExpiry > Date.now());
    const expiry = user?.premiumExpiry ? new Date(user.premiumExpiry).toISOString().split('T')[0] : 'N/A';

    await interaction.editReply({
        embeds: [embed('✨ Premium Status', `# <@${userId}>\n> Premium: ${isPremium ? 'Active ✅' : 'Inactive ❌'}\n> Expires: ${isPremium ? expiry : 'N/A'}`, isPremium ? 0xffd700 : 0x808080)],
    });
}

async function handleBadge(interaction: ChatInputCommandInteraction, action: string, userId: string) {
    const badgeName = interaction.options.getString('badge');

    if (!badgeName) {
        await interaction.editReply({ embeds: [embed('❓ Missing Badge', '# Please specify a badge to add or remove.', 0xffa500)] });
        return;
    }

    const badgeDisplay = getBadge(badgeName);
    if (!badgeDisplay) {
        await interaction.editReply({ embeds: [embed('❓ Invalid Badge', `# Badge \`${badgeName}\` does not exist.`, 0xffa500)] });
        return;
    }

    switch (action) {
        case 'add': return await bgAdd(interaction, userId, badgeName, badgeDisplay);
        case 'remove': return await bgRemove(interaction, userId, badgeName, badgeDisplay);
        case 'check': return await bgCheck(interaction, userId);
        default: return interaction.editReply({ embeds: [embed('❌ Invalid Action', 'Invalid action specified.', 0xff0000)] });
    }
}

async function bgAdd(interaction: ChatInputCommandInteraction, userId: string, badgeName: string, badgeDisplay: string) {
    await Users.addBadge(userId, badgeName);
    await interaction.editReply({
        embeds: [
            new EmbedBuilder()
                .setTitle('🎖️ Badge Awarded!')
                .setDescription(`### Badge Added\n${badgeDisplay}\n\n🎯 Given to: <@${userId}>\n👤 By: <@${interaction.user.id}>`)
                .setColor(0xffd700)
                .setFooter({ text: 'Alice Badge System' })
                .setTimestamp(),
        ],
    });
}

async function bgRemove(interaction: ChatInputCommandInteraction, userId: string, badgeName: string, badgeDisplay: string) {
    const user = await Users.get(userId);
    if (!user?.badges.includes(badgeName)) {
        await interaction.editReply({ embeds: [embed('❓ No Badge', `# <@${userId}> does not have the \`${badgeName}\` badge.`, 0xffa500)] });
        return;
    }
    await Users.removeBadge(userId, badgeName);
    await interaction.editReply({
        embeds: [
            new EmbedBuilder()
                .setTitle('💫 Badge Removed')
                .setDescription(`### Badge Removed\n${badgeDisplay}\n\n🎯 Removed from: <@${userId}>\n👤 By: <@${interaction.user.id}>`)
                .setColor(0xff6b6b)
                .setFooter({ text: 'Alice Badge System' })
                .setTimestamp(),
        ],
    });
}

async function bgCheck(interaction: ChatInputCommandInteraction, userId: string) {
    const user = await Users.get(userId);
    const badges = user?.badges ?? [];

    if (!badges.length) {
        await interaction.editReply({ embeds: [embed('❓ No Badges', `# <@${userId}> has no badges.`, 0xffa500)] });
        return;
    }

    const badgeList = badges.map(b => getBadge(b) || b).join('\n');
    await interaction.editReply({
        embeds: [
            new EmbedBuilder()
                .setTitle('🎖️ User Badges')
                .setDescription(`# <@${userId}>\n\n${badgeList}`)
                .setColor(0xffd700)
                .setTimestamp(),
        ],
    });
}