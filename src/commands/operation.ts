import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { Blacklist } from '../db/database.js';
import { isOwner, isModerator, getLogChannel } from '../config/config.js';
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
        ),

    global: false,
    cooldown: 5,

    execute: async (interaction: ChatInputCommandInteraction): Promise<void> => {
        const mode = interaction.options.getString('mode', true);
        const action = interaction.options.getString('action', true);
        const userId = interaction.options.getString('userid', true);

        if (!isModerator(interaction.user.id) && !isOwner(interaction.user.id)) {
            await interaction.reply({
                embeds: [embed('🚫 No Access!', '# Sorry, cutie!\n> You need to be a bot owner or moderator to use this command.', 0xffb6c1)],
                flags: 64,
            });
            return;
        }

        await interaction.deferReply({ flags: 64 });

        try {
            switch (mode) {
                case 'blacklist':
                    await handleBlacklist(interaction, action, userId);
                    break;
                case 'premium':
                case 'badge':
                    await interaction.editReply({
                        embeds: [embed('🚧 Coming Soon', `# ${mode === 'premium' ? 'Premium' : 'Badge'} operations are not yet available.\n> Check back later!`, 0x808080)],
                    });
                    break;
                default:
                    await interaction.editReply({
                        embeds: [embed('❌ Invalid Mode', 'Invalid mode specified.', 0xff0000)],
                    });
            }
        } catch (err: any) {
            await interaction.editReply({
                embeds: [embed('❌ Error', `An error occurred: \`${err.message}\``, 0xff0000)],
            });
        }
    },
} as Command;


const embed = (title: string, desc: string, color: number) =>
    new EmbedBuilder().setTitle(title).setDescription('```md\n' + desc + '\n```').setColor(color);

const fetchTag = (client: any, id: string) =>
    client.users.fetch(id).then((u: any) => u.tag).catch(() => 'Unknown User');


async function handleBlacklist(interaction: ChatInputCommandInteraction, action: string, userId: string) {
    switch (action) {
        case 'add': return await handleAdd(interaction, userId);
        case 'remove': return await handleRemove(interaction, userId);
        case 'check': return await handleCheck(interaction, userId);
        default:
            return interaction.editReply({
                embeds: [embed('❌ Invalid Action', 'Invalid action specified.', 0xff0000)],
            });
    }
}

async function handleAdd(interaction: ChatInputCommandInteraction, userId: string) {
    const reason = interaction.options.getString('reason') || 'No reason provided.';

    if (await Blacklist.isBlacklisted(userId)) {
        await interaction.editReply({
            embeds: [embed('⚠️ Already Blacklisted', `# User <@${userId}> is already blacklisted.\n> Reason: ${await Blacklist.getReason(userId) || 'Unknown'}`, 0xffa500)],
        });
        return;
    }

    await Blacklist.add(userId, reason);

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

    await interaction.editReply({
        embeds: [embed('✅ Blacklisted', `# <@${userId}> has been blacklisted.\n> Reason: ${reason}`, 0x00ff00)],
    });
}

async function handleRemove(interaction: ChatInputCommandInteraction, userId: string) {
    if (!(await Blacklist.isBlacklisted(userId))) {
        await interaction.editReply({
            embeds: [embed('⚠️ Not Blacklisted', `# <@${userId}> is not blacklisted.`, 0xffa500)],
        });
        return;
    }

    await Blacklist.remove(userId);

    await interaction.editReply({
        embeds: [embed('✅ Unblacklisted', `# <@${userId}> has been removed from the blacklist.`, 0x00ff00)],
    });
}

async function handleCheck(interaction: ChatInputCommandInteraction, userId: string) {
    const isBlacklisted = await Blacklist.isBlacklisted(userId);

    await interaction.editReply({
        embeds: [
            isBlacklisted
                ? embed('🚫 Blacklisted', `# <@${userId}> is blacklisted.\n> Reason: ${await Blacklist.getReason(userId) || 'Unknown'}`, 0xff0000)
                : embed('✅ Not Blacklisted', `# <@${userId}> is not blacklisted.`, 0x00ff00),
        ],
    });
}