import { Events, REST, Routes, Guild } from 'discord.js';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CustomClient } from './client.js';
import { getDevGuild } from '../config/config.js';
import { loadEnv } from '../config/env.js';
import type { Event, Command } from '../types/index.js';

const EXT = ['.ts', '.js', '.mjs'];
const ROOT = process.cwd();
const COMMANDS_DIR = join(ROOT, 'dist', 'src', 'commands');
const EVENTS_DIR = join(ROOT, 'dist', 'src', 'events');

const DEV_GUILD = getDevGuild();

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
    const token = loadEnv('token');
    if (!token) {
        console.error('[deploy] ❌ Missing token in .env — skipping command registration');
        return;
    }
    const rest = new REST({ version: '10' }).setToken(token);
    const globalCmds = commands.filter(c => c.global).map(c => c.data.toJSON());
    const devCmds = commands.filter(c => !c.global).map(c => c.data.toJSON());

    if (client.cluster?.id === 0) {
        const fingerprint = createHash('sha256')
            .update(JSON.stringify([globalCmds, devCmds]))
            .digest('hex');
        if ((await readCache('commands.hash')) === fingerprint) {
            console.log('[deploy] ✅ Commands unchanged — skipping Discord re-registration');
        } else {
            let deployed = false;
            if (globalCmds.length) {
                await rest.put(Routes.applicationCommands(client.user!.id), { body: globalCmds });
                console.log(`[deploy] 🌍 ${globalCmds.length} global command(s) — propagating to all servers`);
                deployed = true;
            }

            if (DEV_GUILD && devCmds.length) {
                try {
                    await rest.put(
                        Routes.applicationGuildCommands(client.user!.id, DEV_GUILD),
                        { body: devCmds }
                    );
                    console.log(`[deploy] ⚡ Dev guild ${DEV_GUILD}: ${devCmds.length} command(s) synced instantly`);
                    deployed = true;
                } catch (error: any) {
                    console.error(
                        `[deploy] ⚠️ Dev guild ${DEV_GUILD} sync skipped (${error?.message ?? error}) — ` +
                        'booting anyway; will retry when the bot joins that guild'
                    );
                }
            }
            // Cache on ANY successful deploy — dev-only changes count too.
            if (deployed) await writeCache('commands.hash', fingerprint);
        }
    }

    // One cluster owns the retry listener — otherwise N clusters PUT at once.
    if (client.cluster?.id === 0) {
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
    }

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

async function getFiles(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (error: any) {
        if (error?.code === 'ENOENT') throw new Error(`Command/event dir missing (did you run npm run build?): ${dir}`);
        throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await getFiles(fullPath));
        else if (EXT.includes(extname(entry.name))) files.push(fullPath);
    }
    return files;
}