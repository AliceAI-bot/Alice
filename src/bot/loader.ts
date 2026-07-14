import { Events, REST, Routes, Guild } from 'discord.js';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { CustomClient } from './client.js';
import type { Event, Command } from '../types/index.js';

const EXT = ['.ts', '.js', '.mjs'];

const ROOT = process.cwd();
const COMMANDS_DIR = join(ROOT, 'dist', 'src', 'commands');
const EVENTS_DIR = join(ROOT, 'dist', 'src', 'events');
const registeredGuilds = new Set<string>();

export async function ready(client: CustomClient): Promise<void> {
    await loadEvents(client);
    const commands = await loadCommands(client);
    await deployCommands(client, commands);
}

export async function loadEvents(client: CustomClient): Promise<void> {
    const files = await getFiles(EVENTS_DIR);
    let loaded = 0;

    for (const file of files) {
        try {
            const mod = await import(file);
            const event: Event = mod.default ?? mod;

            if (!event?.name || typeof event.execute !== 'function') {
                console.warn(`[events] Skipping ${file} — missing name or execute`);
                continue;
            }

            const handler = (...args: unknown[]) => {
                (event.execute as any)(...args, client);
            };

            event.once
                ? client.once(event.name, handler)
                : client.on(event.name, handler);

            loaded++;
        } catch (err) {
            console.error(`[events] Failed to load ${file}:`, err);
        }
    }

    console.log(`[events] Total loaded: ${loaded}`);
}


export async function loadCommands(client: CustomClient): Promise<Command[]> {
    const files = await getFiles(COMMANDS_DIR);
    const commands: Command[] = [];
    let loaded = 0;

    for (const file of files) {
        try {
            const mod = await import(file);
            const cmd: Command = mod.default ?? mod;

            if (!cmd?.data?.name || typeof cmd.execute !== 'function') {
                console.warn(`[commands] Skipping ${file} — missing data.name or execute`);
                continue;
            }

            client.slashCommands.set(cmd.data.name, cmd);
            commands.push(cmd);
            loaded++;;
        } catch (err) {
            console.error(`[commands] Failed to load ${file}:`, err);
        }
    }

    console.log(`[commands] Total loaded: ${loaded}`);
    return commands;
}


export async function deployCommands(client: CustomClient, commands: Command[]): Promise<void> {
    const clusterId = client.cluster?.id ?? 0;

    if (clusterId !== 0) {
        console.log(`[deploy] Cluster ${clusterId} skipping deployment`);
        return;
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

    const globalCmds = commands.filter(c => c.global).map(c => c.data.toJSON());
    const guildCmds = commands.filter(c => !c.global).map(c => c.data.toJSON());
    const allCmds = [...globalCmds, ...guildCmds];

    if (allCmds.length === 0) {
        console.log('[deploy] No commands to register');
        return;
    }

    console.log('Refreshing guild cache...');
    await client.guilds.fetch();

    await registerGuildCommands(client, rest, allCmds);

    client.on(Events.GuildCreate, async (guild) => {
        await handleNewGuild(guild, client, rest, allCmds);
    });

    console.log('Command registration system ready');
}


async function registerGuildCommands(
    client: CustomClient,
    rest: REST,
    guildCmds: unknown[]
): Promise<void> {
    if (guildCmds.length === 0) return;

    const guilds = client.guilds.cache;
    console.log(`[deploy] Registering commands for ${guilds.size} guilds...`);

    for (const [guildId, guild] of guilds) {
        if (registeredGuilds.has(guildId)) continue;

        try {
            await rest.put(
                Routes.applicationGuildCommands(client.user!.id, guildId),
                { body: guildCmds }
            );
            registeredGuilds.add(guildId);
        } catch (error: any) {
            if (error.code === 50001) {
                console.warn(`[deploy] ⚠️ Skipping ${guild.name} (${guildId}) — missing permissions`);
            } else {
                console.error(`[deploy] ❌ Failed for ${guild.name} (${guildId}):`, error.message);
            }
        }
    }
}


async function handleNewGuild(
    guild: Guild,
    client: CustomClient,
    rest: REST,
    guildCmds: unknown[]
): Promise<void> {
    if (guildCmds.length === 0 || registeredGuilds.has(guild.id)) return;
    try {
        await rest.put(
            Routes.applicationGuildCommands(client.user!.id, guild.id),
            { body: guildCmds }
        );
        registeredGuilds.add(guild.id);
    } catch (error: any) {
        console.error(`[deploy] ❌ Failed for ${guild.name}:`, error.message);
    }
}


async function getFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await getFiles(fullPath));
        } else if (EXT.includes(extname(entry.name))) {
            files.push(fullPath);
        }
    }

    return files;
}
