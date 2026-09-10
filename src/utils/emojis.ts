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
        // Single pass: existing custom-emoji markup passes through untouched
        // (it literally contains a ":name:" substring), known [name] / :name:
        // resolve, and anything unknown ([wry], :wry:) is stripped so invented
        // tags never leak into chat. Known alternatives come first so they win.
        cache = {
            map,
            tagRe: new RegExp(
                `(<a?:\\w+:\\d+>)|\\[(${source})\\](?!\\s*\\()|:(${source}):|\\[[A-Za-z0-9_+/-]+\\](?!\\s*\\()|:([A-Za-z]{2,}):`,
                'gi',
            ),
        };
    }
    return cache;
}

export function applyEmojis(text: string): string {
    if (!text) return text;
    const { map, tagRe } = getCache();
    if (!map.size) return text;
    const replaced = text.replace(
        tagRe,
        (tag, custom: string, bracket: string, colon: string, _stripBracket: string, _stripColon: string) => {
            if (custom) return tag;
            const name = (bracket ?? colon ?? '').toLowerCase();
            if (name) return map.get(name) ?? tag;
            // Unknown [tag] / :tag: — strip it.
            return '';
        },
    );
    return replaced.replace(/ {2,}/g, ' ').trim();
}
