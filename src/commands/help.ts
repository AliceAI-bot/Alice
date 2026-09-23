import {
    SlashCommandBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    version as discordVersion,
} from 'discord.js';
import { cpus, totalmem, freemem } from 'os';
import type { Command } from '../types/index.js';
import { baseEmbed, inviteRow } from '../utils/embeds.js';

export default {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Displays the help menu with various options and links.'),

    global: true,
    cooldown: 5,

    execute: async (interaction) => {
        await interaction.deferReply();

        const embed = baseEmbed(
            interaction,
            '💡 Help Menu',
            '```md\n# Available Categories\n' +
                '✨ Commands    - Available commands\n' +
                '🤖 Bot Info    - Information about Alice\n```\n' +
                '> Select a category below to view more!',
        );

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('help_select')
            .setPlaceholder('Choose a category to view')
            .addOptions([
                {
                    label: 'Commands',
                    description: 'View available commands',
                    value: 'commands',
                    emoji: '✨',
                },
                {
                    label: 'Bot Information',
                    description: 'View information about Alice',
                    value: 'info',
                    emoji: '🤖',
                },
            ]);

        const menuRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        const buttonRow = inviteRow(interaction.client.user?.id ?? '');

        const reply = await interaction.followUp({
            embeds: [embed],
            components: [menuRow, buttonRow],
        });

        try {
            const filter = (i: any) => i.customId === 'help_select' && i.user.id === interaction.user.id;
            // Message-scoped: concurrent /help calls never see each other's selects.
            const collector = reply.createMessageComponentCollector({
                filter,
                time: 60000,
            });

            // AI-related commands get their own section; dev-only (global:false)
            // commands never appear here.
            const AI_COMMANDS = new Set(['chat', 'reset_session', 'byok']);

            collector?.on('collect', async (i: any) => {
                try {
                    const selectedValue = i.values[0];
                    const newEmbed = baseEmbed(interaction, '', '');

                    switch (selectedValue) {
                    case 'commands': {
                        const cmds = ((interaction.client as any).slashCommands?.values?.() ?? []) as Array<{
                            data?: { name?: string; description?: string };
                            global?: boolean;
                        }>;
                        const listed = [...cmds]
                            .filter((c) => c?.data?.name && c.global !== false)
                            .sort((a, b) => (a.data!.name! < b.data!.name! ? -1 : 1));
                        const describe = (c: { data?: { name?: string; description?: string } }) =>
                            `\`/${c.data!.name!}\` • ${c.data!.description ?? ''}`.trim();
                        const utility = listed.filter((c) => !AI_COMMANDS.has(c.data!.name!)).map(describe);
                        const ai = listed.filter((c) => AI_COMMANDS.has(c.data!.name!)).map(describe);
                        newEmbed
                            .setTitle('✨ Commands')
                            .setDescription('```md\n# Available Commands```')
                            .addFields(
                                {
                                    name: '🎯 Utility',
                                    value: utility.length ? utility.join('\n') : '> Nothing here yet',
                                    inline: false,
                                },
                                {
                                    name: '🤖 AI',
                                    value: ai.length ? ai.join('\n') : '> Nothing here yet',
                                    inline: false,
                                },
                            );
                        break;
                    }

                    case 'info':
                        const botUser = interaction.client.user!;
                        const botCreationDateUnix = Math.floor(botUser.createdAt.getTime() / 1000);
                        const timeSinceCreation = `<t:${botCreationDateUnix}:R>`;

                        const uptime = interaction.client.uptime ?? 0;
                        const days = Math.floor(uptime / 86400000);
                        const hours = Math.floor(uptime / 3600000) % 24;
                        const minutes = Math.floor(uptime / 60000) % 60;
                        const uptimeStr = `${days}d ${hours}h ${minutes}m`;

                        const cores = cpus().length;
                        const memoryTotal = (totalmem() / 1024 / 1024 / 1024).toFixed(2);
                        const memoryFree = (freemem() / 1024 / 1024 / 1024).toFixed(2);
                        const memoryUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
                        const ping = Math.round(interaction.client.ws.ping);
                        const nodeVersion = process.version;

                        const customClient = interaction.client as any;
                        const clusterClient = customClient.cluster;

                        let totalGuilds = 0;
                        let totalUsers = 0;
                        let totalChannels = 0;
                        let clusterInfo = 'N/A';
                        let shardInfo = 'N/A';

                        try {
                            if (clusterClient && clusterClient.manager) {
                                clusterInfo = `Cluster ${clusterClient.id} / ${clusterClient.manager.totalClusters}`;
                                shardInfo = `${clusterClient.shardList.join(', ')} / ${clusterClient.shardCount}`;

                                // Single broadcast for all totals instead of three round-trips.
                                const results = (await clusterClient.manager.broadcastEval((c: any) => ({
                                    guilds: c.guilds.cache.size,
                                    channels: c.channels.cache.size,
                                    users: c.guilds.cache.reduce(
                                        (total: number, guild: any) => total + (guild.memberCount || 0),
                                        0
                                    ),
                                }))) as Array<{ guilds: number; channels: number; users: number }>;

                                totalGuilds = results.reduce((a, b) => a + b.guilds, 0);
                                totalChannels = results.reduce((a, b) => a + b.channels, 0);
                                totalUsers = results.reduce((a, b) => a + b.users, 0);
                            } else if (clusterClient) {
                                clusterInfo = `${clusterClient.id}`;
                                shardInfo = `${clusterClient.shardList.join(', ')} / ${clusterClient.shardCount}`;
                                totalGuilds = interaction.client.guilds.cache.size;
                                totalUsers = interaction.client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
                                totalChannels = interaction.client.channels.cache.size;
                            } else {
                                totalGuilds = interaction.client.guilds.cache.size;
                                totalUsers = interaction.client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
                                totalChannels = interaction.client.channels.cache.size;
                                clusterInfo = 'Single Process';
                                shardInfo = 'No Sharding';
                            }
                        } catch (error) {
                            console.error('Error fetching stats:', error);
                            totalGuilds = interaction.client.guilds.cache.size;
                            totalUsers = interaction.client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
                            totalChannels = interaction.client.channels.cache.size;
                        }

                        const totalCommands = customClient.slashCommands?.size || 0;
                        const banner = botUser.bannerURL({ size: 4096 });

                        newEmbed
                            .setTitle('🤖 Bot Information')
                            .setDescription('```md\n# About Alice\n🌸 Your ever-curious chatter companion ~ (≧◡≦) ♡```')
                            .setImage(banner ?? null)
                            .addFields(
                                {
                                    name: '📋 About',
                                    value: `> 🌸 Hello there, I'm Alice, your AI friend!\n> Created: <t:${botCreationDateUnix}:D> (${timeSinceCreation})`,
                                    inline: false,
                                },
                                {
                                    name: '📊 CLuster Info',
                                    value: [
                                        '```ml',
                                        `Cluster    : ${clusterInfo}`,
                                        `Servers    : ${totalGuilds.toLocaleString()}`,
                                        `Channels   : ${totalChannels.toLocaleString()}`,
                                        `Users      : ${totalUsers.toLocaleString()}`,
                                        `Commands   : ${totalCommands}`,
                                        `Shards     : ${shardInfo}`,
                                        '```',
                                    ].join('\n'),
                                    inline: false,
                                },
                                {
                                    name: '📊 Performance',
                                    value: [
                                        '```ml',
                                        `CPU Cores   : ${cores}`,
                                        `Memory Total: ${memoryTotal}GB`,
                                        `Memory Free : ${memoryFree}GB`,
                                        `Memory Used : ${memoryUsed}MB`,
                                        `Ping        : ${ping}ms`,
                                        '```',
                                    ].join('\n'),
                                    inline: false,
                                },
                                {
                                    name: '⚙️ System',
                                    value: [
                                        '```ml',
                                        `Node.js    : ${nodeVersion}`,
                                        `Discord.js : v${discordVersion}`,
                                        `Uptime     : ${uptimeStr}`,
                                        '```',
                                    ].join('\n'),
                                    inline: false,
                                }
                            );
                        break;
                }

                await i.update({
                    embeds: [newEmbed],
                    components: [menuRow, buttonRow],
                }).catch(console.error);
                } catch (error) {
                    console.error('Error handling help select:', error);
                    await i.reply({
                        content: 'Something went wrong showing that section — try again.',
                        flags: 64,
                    }).catch(() => null);
                }
            });

            collector?.on('end', () => {
                const disabledMenu = (menuRow.components[0] as StringSelectMenuBuilder).setDisabled(true);
                const updatedRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(disabledMenu);

                interaction.editReply({
                    components: [updatedRow, buttonRow],
                }).catch(console.error);
            });
        } catch (error) {
            console.error('Error in help command:', error);
            await interaction.editReply({
                content: 'An error occurred while processing the help command.',
                components: [],
            }).catch(console.error);
        }
    },
} as Command;