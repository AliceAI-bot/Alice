import fs from 'fs';
import path from 'path';

interface Config {
    devs: string[];
    moderators: string[];
    logs: {
        blacklist: string;
        premium: string;
    };
    devGuild: string;
}

let config: Config;
let initialized = false;

function loadConfig(): Config {
    if (initialized && config) return config;

    try {
        const configPath = path.join(process.cwd(), 'config.json');
        const data = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(data);
        initialized = true;
        return config;
    } catch (error) {
        throw error;
    }
}

export function getConfig(): Config {
    return loadConfig();
}

export function isOwner(userId: string | number): boolean {
    const cfg = getConfig();
    const idStr = String(userId);
    return cfg.devs.includes(idStr);
}

export function isModerator(userId: string | number): boolean {
    const cfg = getConfig();
    const idStr = String(userId);
    return cfg.moderators.includes(idStr);
}

export function getLogChannel(type: 'blacklist' | 'premium'): string {
    const cfg = getConfig();
    return cfg.logs[type];
}

export function getDevGuild(): string {
    const cfg = getConfig();
    return cfg.devGuild;
}