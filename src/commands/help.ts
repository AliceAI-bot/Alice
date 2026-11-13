import {
    Collection,
    EmbedBuilder,
    SlashCommandBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    version as discordVersion,
    type ChatInputCommandInteraction,
} from 'discord.js';
import { cpus, totalmem, freemem } from 'os';
import type { Command } from '../types/index.js';
import { baseEmbed, inviteRow } from '../utils/embeds.js';

/** Shape of a registered slash command, for listing in the Commands section. */
interface CommandLike {
    data?: { name?: string; description?: string };
    global?: boolean;
}

/** discord-hybrid-sharding surface used by the info section. */
interface ClusterLike {
    id: number;
    shardList: number[];
    shardCount: number;
    manager: {
        totalClusters: number;
        broadcastEval(
            fn: (c: any) => { guilds: number; channels: number; users: number },
        ): Promise<Array<{ guilds: number; channels: number; users: number }>>;
    } | null;
}

// AI-related commands get their own section; dev-only (global:false) commands never appear.
const AI_COMMANDS = new Set(['chat', 'reset_session', 'byok']);

function listedCommands(interaction: ChatInputCommandInteraction): CommandLike[] {
    const registry = interaction.client as unknown as {
        slashCommands?: Collection<string, CommandLike>;
    };
    return [...(registry.slashCommands?.values() ?? [])]
        .filter((c) => c?.data?.name && c.global !== false)
        .toSorted((a, b) => (a.data!.name! < b.data!.name! ? -1 : 1));
}

function buildCommandsEmbed(interaction: ChatInputCommandInteraction): EmbedBuilder {
    const describe = (c: CommandLike) => `\`/${c.data!.name!}\` • ${c.data!.description ?? ''}`.trim();
    const listed = listedCommands(interaction);
    const section = (matches: (c: CommandLike) => boolean): string =>
        listed.filter(matches).map(describe).join('\n') || '> Nothing here yet';

    return baseEmbed(interaction, '✨ Commands', '```md\n# Available Commands```').addFields(
        { name: '🎯 Utility', value: section((c) => !AI_COMMANDS.has(c.data!.name!)) },
        { name: '🤖 AI', value: section((c) => AI_COMMANDS.has(c.data!.name!)) },
    );
}

async function buildInfoEmbed(interaction: ChatInputCommandInteraction): Promise<EmbedBuilder> {
    const botUser = interaction.client.user!;
    const createdUnix = Math.floor(botUser.createdAt.getTime() / 1000);
    const since = `<t:${createdUnix}:R>`;

    const uptime = interaction.client.uptime ?? 0;
    const uptimeStr = `${Math.floor(uptime / 86_400_000)}d ${Math.floor(uptime / 3_600_000) % 24}h ${Math.floor(uptime / 60_000) % 60}m`;

    const cores = cpus().length;
    const toGB = (bytes: number): string => (bytes / 1024 / 1024 / 1024).toFixed(2);
    const memoryTotal = toGB(totalmem());
    const memoryFree = toGB(freemem());
    const memoryUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ping = Math.round(interaction.client.ws.ping);
    const nodeVersion = process.version;

    // Local totals first; cluster branches override them.
    let clusterInfo = 'Single Process';
    let shardInfo = 'No Sharding';
    let totalGuilds = interaction.client.guilds.cache.size;
    let totalUsers = interaction.client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
    let totalChannels = interaction.client.channels.cache.size;
    const totalCommands = (interaction.client as unknown as { slashCommands?: { size?: number } }).slashCommands?.size || 0;

    try {
        const cluster = (interaction.client as unknown as { cluster?: ClusterLike }).cluster;
        if (cluster && cluster.manager) {
            clusterInfo = `Cluster ${cluster.id} / ${cluster.manager.totalClusters}`;
            shardInfo = `${cluster.shardList.join(', ')} / ${cluster.shardCount}`;
            // Single broadcast for all totals instead of three round-trips.
            const results = await cluster.manager.broadcastEval((c: any) => ({
                guilds: c.guilds.cache.size,
                channels: c.channels.cache.size,
                users: c.guilds.cache.reduce((total: number, guild: any) => total + (guild.memberCount || 0), 0),
            }));
            totalGuilds = results.reduce((a, b) => a + b.guilds, 0);
            totalChannels = results.reduce((a, b) => a + b.channels, 0);
            totalUsers = results.reduce((a, b) => a + b.users, 0);
        } else if (cluster) {
            clusterInfo = `${cluster.id}`;
            shardInfo = `${cluster.shardList.join(', ')} / ${cluster.shardCount}`;
        }
    } catch (error) {
        console.error('Error fetching stats:', error);
    }

    return baseEmbed(
        interaction,
        '🤖 Bot Information',
        '```md\n# About Alice\n🌸 Your ever-curious chatter companion ~ (≧◡≦) ♡```',
    )
        .setImage(botUser.bannerURL({ size: 4096 }) ?? null)
        .addFields(
            {
                name: '📋 About',
                value: `> 🌸 Hello there, I'm Alice, your AI friend!\n> Created: <t:${createdUnix}:D> (${since})`,
            },
            {
                name: '📊 Cluster Info',
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
            },
        );
}

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

            collector?.on('collect', async (i: any) => {
                try {
                    const newEmbed = await (i.values[0] === 'info'
                        ? buildInfoEmbed(interaction)
                        : buildCommandsEmbed(interaction));
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
