import fs from 'fs';
import path from 'path';

interface Config {
    devs: string[];
    moderators: string[];
    logs: {
        blacklist: string;
        'flagged_Content': string;
        premium: string;
    };
    devGuild: string;
    badges: Record<string, string>;
    emojis: { name: string; emoji: string }[];
}

let config: Config | null = null;

export function getConfig(): Config {
    if (!config) {
        const configPath = path.join(process.cwd(), 'config.json');
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Config;
    }
    return config;
}

function idListed(ids: string[], userId: string | number): boolean {
    return ids.includes(String(userId));
}

export function isOwner(userId: string | number): boolean {
    return idListed(getConfig().devs, userId);
}

export function isModerator(userId: string | number): boolean {
    return idListed(getConfig().moderators, userId);
}

export type LogChannelType = 'blacklist' | 'flagged_Content' | 'premium';

export function getLogChannel(type: LogChannelType): string {
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
