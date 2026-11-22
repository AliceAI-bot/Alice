import {
    ActionRowBuilder,
    ComponentType,
    EmbedBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    version as discordVersion,
    type ChatInputCommandInteraction,
} from 'discord.js';
import { cpus, totalmem, freemem } from 'os';
import type { Command } from '../types/index.js';
import type { CustomClient } from '../bot/client.js';
import { baseEmbed, inviteRow } from '../utils/embeds.js';

// AI-related commands get their own section; dev-only (global:false) commands never appear.
const AI_COMMANDS = new Set(['chat', 'reset_session', 'byok']);

function listedCommands(interaction: ChatInputCommandInteraction): Command[] {
    const registry = interaction.client as CustomClient;
    return [...registry.slashCommands.values()]
        .filter((c) => c.global !== false)
        .toSorted((a, b) => a.data.name.localeCompare(b.data.name));
}

function commandDescription(command: Command): string {
    return 'description' in command.data ? command.data.description : '';
}

function buildCommandsEmbed(interaction: ChatInputCommandInteraction): EmbedBuilder {
    const describe = (c: Command): string => `\`/${c.data.name}\` • ${commandDescription(c)}`;
    const listed = listedCommands(interaction);
    const section = (matches: (c: Command) => boolean): string =>
        listed.filter(matches).map(describe).join('\n') || '> Nothing here yet';

    return baseEmbed(interaction, '✨ Commands', '```md\n# Available Commands\n```').addFields(
        { name: '🎯 Utility', value: section((c) => !AI_COMMANDS.has(c.data.name)) },
        { name: '🤖 AI', value: section((c) => AI_COMMANDS.has(c.data.name)) },
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
    const client = interaction.client as CustomClient;

    // Local totals first; cluster branches override them.
    let clusterInfo = 'Single Process';
    let shardInfo = 'No Sharding';
    let totalGuilds = client.guilds.cache.size;
    let totalUsers = client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
    let totalChannels = client.channels.cache.size;
    const totalCommands = client.slashCommands.size;

    try {
        const cluster = client.cluster;
        if (cluster) {
            const info = cluster.info;
            clusterInfo = `Cluster ${info.CLUSTER} / ${info.CLUSTER_COUNT}`;
            shardInfo = `${cluster.shardList.join(', ')} / ${info.TOTAL_SHARDS}`;
            // Single broadcast for all totals instead of three round-trips.
            const results = await cluster.broadcastEval((c) => ({
                guilds: c.guilds.cache.size,
                channels: c.channels.cache.size,
                users: c.guilds.cache.reduce((total, guild) => total + (guild.memberCount || 0), 0),
            }));
            totalGuilds = results.reduce((a, b) => a + b.guilds, 0);
            totalChannels = results.reduce((a, b) => a + b.channels, 0);
            totalUsers = results.reduce((a, b) => a + b.users, 0);
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

        const collector = reply.createMessageComponentCollector<ComponentType.StringSelect>({
            filter: (i) => i.customId === 'help_select' && i.user.id === interaction.user.id,
            time: 60000,
        });

        collector.on('collect', async (i) => {
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

        collector.on('end', () => {
            menuRow.components[0]?.setDisabled(true);
            interaction.editReply({
                components: [menuRow, buttonRow],
            }).catch(console.error);
        });
    },
} as Command;
