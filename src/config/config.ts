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
  badges: Record<string, string>;
  emojis: { name: string; emoji: string }[];
}

let config: Config;

function loadConfig(): Config {
    if (config) return config;

    const configPath = path.join(process.cwd(), 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config;
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

export function getBadge(name: string): string | undefined {
    return getConfig().badges[name];
}

export function getEmojis(): { name: string; emoji: string }[] {
    return getConfig().emojis;
}