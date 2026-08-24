import { getEmojis } from '../config/config.js';

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

interface EmojiCache {
    map: Map<string, string>;
    tagRe: RegExp;
}

let cache: EmojiCache | null = null;

function getCache(): EmojiCache {
    if (!cache) {
        const entries = getEmojis() ?? [];
        const map = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.emoji]));
        const source = entries
            .map((entry) => entry.name.replace(RE_SPECIAL, '\\$&'))
            .join('|');
        cache = { map, tagRe: new RegExp(`\\[(${source})\\](?!\\s*\\()`, 'gi') };
    }
    return cache;
}

export function applyEmojis(text: string): string {
    if (!text) return text;
    const { map, tagRe } = getCache();
    if (!map.size) return text;
    return text.replace(tagRe, (tag, name: string) => map.get(name.toLowerCase()) ?? tag);
}
