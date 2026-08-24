import { Events, REST, Routes, Guild } from 'discord.js';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

    if (client.cluster?.id === 0) {
        const fingerprint = createHash('sha256')
            .update(JSON.stringify([globalCmds, devCmds]))
            .digest('hex');
        if ((await readCache('commands.hash')) === fingerprint) {
            console.log('[deploy] ✅ Commands unchanged — skipping Discord re-registration');
        } else {
            if (globalCmds.length) {
                await rest.put(Routes.applicationCommands(client.user!.id), { body: globalCmds });
                console.log(`[deploy] 🌍 ${globalCmds.length} global command(s) — propagating to all servers`);
            }

            if (DEV_GUILD && devCmds.length) {
                await rest.put(
                    Routes.applicationGuildCommands(client.user!.id, DEV_GUILD),
                    { body: devCmds }
                );
                console.log(`[deploy] ⚡ Dev guild ${DEV_GUILD}: ${devCmds.length} command(s) synced instantly`);
            }

            await writeCache('commands.hash', fingerprint);
        }
    }

    client.on(Events.GuildCreate, async (guild: Guild) => {
        if (guild.id !== DEV_GUILD || !devCmds.length) return;

        try {
            await rest.put(
                Routes.applicationGuildCommands(client.user!.id, guild.id),
                { body: devCmds }
            );
            console.log(`[deploy] ⚡ Dev guild ${guild.name}: ${devCmds.length} command(s) synced instantly`);
        } catch (error: any) {
            console.error(`[deploy] ❌ ${guild.name}:`, error.message);
        }
    });

    await purgeStaleGuildCommands(client, rest, devCmds);

    console.log('[deploy] ✅ Ready — global propagation in progress, dev guild live');
}

const CACHE_DIR = join(ROOT, '.deploy-cache');

async function readCache(name: string): Promise<string | null> {
    try {
        return await readFile(join(CACHE_DIR, name), 'utf-8');
    } catch {
        return null;
    }
}

async function writeCache(name: string, data: string): Promise<void> {
    try {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(join(CACHE_DIR, name), data);
    } catch (error) {
        console.error(`[deploy] ⚠️ cache write failed (${name}):`, error);
    }
}

async function purgeStaleGuildCommands(client: CustomClient, rest: REST, devCmds: object[]): Promise<void> {
    const marker = `purged-c${client.cluster?.id ?? 0}`;
    if (await readCache(marker)) return;

    const pending = [...client.guilds.cache.values()];
    if (!pending.length) return;
    let done = 0;
    let cursor = 0;

    await Promise.all(Array.from({ length: Math.min(5, pending.length) }, async () => {
        while (cursor < pending.length) {
            const guild = pending[cursor++]!;
            const body = guild.id === DEV_GUILD ? devCmds : [];
            try {
                await rest.put(Routes.applicationGuildCommands(client.user!.id, guild.id), { body });
                done++;
            } catch (error: any) {
                if (error?.code === 50001) console.warn(`[deploy] ⚠️ ${guild.name} — no slash perms, skipped`);
                else console.error(`[deploy] ❌ purge ${guild.name}:`, error.message);
            }
        }
    }));

    await writeCache(marker, '1');
    console.log(`[deploy] 🧹 Stale guild commands purged from ${done}/${pending.length} guild(s)`);
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