import {
    SlashCommandBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    version as discordVersion,
} from 'discord.js';
import { cpus, totalmem, freemem } from 'os';
import type { Command } from '../types/index.js';

const createButtonRow = () => {
    return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel('Add to Server')
                .setURL('https://discord.com/oauth2/authorize?client_id=1111646562687397928&permissions=140126800960&scope=bot')
                .setEmoji('➕'),
            new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel('Support Server')
                .setURL('https://discord.gg/j2wh9ctD9N')
                .setEmoji('💫'),
            new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel('Vote on Top.gg')
                .setURL('https://top.gg/bot/1111646562687397928#reviews')
                .setEmoji('⭐'),
        );
};

export default {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Displays the help menu with various options and links.'),

    global: true,
    cooldown: 5,

    execute: async (interaction) => {
        await interaction.deferReply();

        const embed = new EmbedBuilder()
            .setTitle('💡 Help Menu')
            .setDescription(
                '```md\n# Available Categories\n' +
                '✨ Commands    - Available commands\n' +
                '🤖 Bot Info    - Information about Alice\n```\n' +
                '> Select a category below to view more!'
            )
            .setColor('#FFD700')
            .setThumbnail(interaction.client.user?.displayAvatarURL())
            .setTimestamp()
            .setFooter({
                text: `Requested by ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL(),
            });

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
        const buttonRow = createButtonRow();

        await interaction.followUp({
            embeds: [embed],
            components: [menuRow, buttonRow],
        });

        try {
            const filter = (i: any) => i.customId === 'help_select' && i.user.id === interaction.user.id;
            const collector = interaction.channel?.createMessageComponentCollector({
                filter,
                time: 60000,
            });

            collector?.on('collect', async (i: any) => {
                const selectedValue = i.values[0];
                const newEmbed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setThumbnail(interaction.client.user?.displayAvatarURL())
                    .setTimestamp()
                    .setFooter({
                        text: `Requested by ${interaction.user.tag}`,
                        iconURL: interaction.user.displayAvatarURL(),
                    });

                switch (selectedValue) {
                    case 'commands':
                        newEmbed
                            .setTitle('✨ Commands')
                            .setDescription('```md\n# Available Commands```')
                            .addFields(
                                {
                                    name: '🎯 Utility',
                                    value: [
                                        '`/ping` • Check bot latency',
                                        '`/invite` • Invite Alice to your server',
                                        '`/help` • Show this help menu',
                                        '`/profile` • View your or another user\'s profile',
                                    ].join('\n'),
                                    inline: false,
                                }
                            );
                        break;

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

                                const results = await clusterClient.manager.fetchClientValues('guilds.cache.size') as number[];
                                totalGuilds = results.reduce((a, b) => a + b, 0);

                                const userResults = (await clusterClient.manager.broadcastEval((c: any) =>
                                    c.guilds.cache.reduce((total: number, guild: any) => total + (guild.memberCount || 0), 0)
                                )) as number[];
                                totalUsers = userResults.reduce((a, b) => a + b, 0);

                                const channelResults = await clusterClient.manager.fetchClientValues('channels.cache.size') as number[];
                                totalChannels = channelResults.reduce((a, b) => a + b, 0);
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