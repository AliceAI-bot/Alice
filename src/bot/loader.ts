import { Events, REST, Routes, Guild } from 'discord.js';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CustomClient } from './client.js';
import { getDevGuild } from '../config/config.js';
import type { Event, Command } from '../types/index.js';

const EXT = ['.ts', '.js', '.mjs'];
const ROOT = process.cwd();
const COMMANDS_DIR = join(ROOT, 'dist', 'src', 'commands');
const EVENTS_DIR = join(ROOT, 'dist', 'src', 'events');

const DEV_GUILD = (() => {
    const raw = getDevGuild();
    return Array.isArray(raw) ? raw[0] : raw;
})();

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
            const mod = await import(pathToFileURL(file).href);
            const event: Event = mod.default ?? mod;
            if (!event?.name || typeof event.execute !== 'function') continue;
            const handler = (...args: unknown[]) => (event.execute as any)(...args, client);
            event.once ? client.once(event.name, handler) : client.on(event.name, handler);
            loaded++;
        } catch (err) {
            console.error(`[events] Failed ${file}:`, err);
        }
    }
    console.log(`[events] Loaded: ${loaded}`);
}

export async function loadCommands(client: CustomClient): Promise<Command[]> {
    const files = await getFiles(COMMANDS_DIR);
    const commands: Command[] = [];
    let loaded = 0;
    for (const file of files) {
        try {
            const mod = await import(pathToFileURL(file).href);
            const cmd: Command = mod.default ?? mod;
            if (!cmd?.data?.name || typeof cmd.execute !== 'function') continue;
            client.slashCommands.set(cmd.data.name, cmd);
            commands.push(cmd);
            loaded++;
        } catch (err) {
            console.error(`[commands] Failed ${file}:`, err);
        }
    }
    console.log(`[commands] Loaded: ${loaded}`);
    return commands;
}

export async function deployCommands(client: CustomClient, commands: Command[]): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(process.env.token!);
    const globalCmds = commands.filter(c => c.global).map(c => c.data.toJSON());
    const devCmds = commands.filter(c => !c.global).map(c => c.data.toJSON());

    if (globalCmds.length) {
        await rest.put(Routes.applicationCommands(client.user!.id), { body: globalCmds });
        console.log(`[deploy] 🌍 ${globalCmds.length} global command(s) — propagating to all servers`);
    }

    if (DEV_GUILD) {
        const allForDev = [...globalCmds, ...devCmds];
        await rest.put(
            Routes.applicationGuildCommands(client.user!.id, DEV_GUILD),
            { body: allForDev }
        );
        console.log(`[deploy] ⚡ Dev guild ${DEV_GUILD}: ${allForDev.length} command(s) synced instantly`);
    }

    const knownGuilds = new Set(client.guilds.cache.keys());

    client.on(Events.GuildDelete, (guild) => knownGuilds.delete(guild.id));

    client.on(Events.GuildCreate, async (guild: Guild) => {
        if (knownGuilds.has(guild.id)) return;

        const body = [...globalCmds];
        if (guild.id === DEV_GUILD) body.push(...devCmds);

        try {
            await rest.put(
                Routes.applicationGuildCommands(client.user!.id, guild.id),
                { body }
            );
            knownGuilds.add(guild.id);
        } catch (error: any) {
            if (error.code === 50001) {
                console.warn(`[deploy] ⚠️ ${guild.name} — no slash perms, skipped`);
            } else {
                console.error(`[deploy] ❌ ${guild.name}:`, error.message);
            }
        }
    });

    console.log('[deploy] ✅ Ready — global propagation in progress, dev guild live');
}

async function getFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await getFiles(fullPath));
        else if (EXT.includes(extname(entry.name))) files.push(fullPath);
    }
    return files;
}