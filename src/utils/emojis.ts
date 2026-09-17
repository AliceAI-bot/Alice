import { getEmojis } from '../config/config.js';

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

interface EmojiCache {
    map: Map<string, string>;
    tagRe: RegExp;
}

let cache: EmojiCache | null = null;

// Unicode pictographs never render as Alice — only [tags] resolve to emojis.
// Strip them (plus leftover variation selectors / ZWJ / keycap marks) so model
// slip never leaks yellow emojis into chat. ASCII [tags] are unaffected.
const UNICODE_PICTO_RE = /\p{Extended_Pictographic}\uFE0F?/gu;
const EMOJI_MOD_RE = /[\uFE0E\uFE0F\u200D\u20E3]/g;

function stripUnicodeEmojis(text: string): string {
    return text.replace(UNICODE_PICTO_RE, '').replace(EMOJI_MOD_RE, '');
}

function getCache(): EmojiCache {
    if (!cache) {
        const entries = getEmojis() ?? [];
        const map = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.emoji]));
        const source = entries
            .map((entry) => entry.name.replace(RE_SPECIAL, '\\$&'))
            .join('|');
        // Single pass: existing custom-emoji markup passes through untouched.
        // Known [name] / :name: resolve. Unknown ([wry], :wry:) is stripped
        // so invented tags never leak.
        cache = {
            map,
            tagRe: new RegExp(
                `(<a?:\\w+:\\d+>)|\\[(${source})\\](?!\\s*\\()|:(${source}):|\\[[A-Za-z0-9_+/-]+\\](?!\\s*\\()|:([A-Za-z0-9_]{2,}):`,
                'gi',
            ),
        };
    }
    return cache;
}

export function applyEmojis(text: string): string {
    if (!text) return text;
    // Strip Unicode emoji first (always, even with zero tags configured),
    // then resolve tags — first tag wins, later ones are dropped so a reply
    // never carries more than one emoji (second sentence gets none).
    let replaced = stripUnicodeEmojis(text);
    const { map, tagRe } = getCache();
    if (map.size) {
        let seen = false;
        replaced = replaced.replace(
            tagRe,
            (tag, custom: string, bracket: string, colon: string, _stripBracket: string, _stripColon: string) => {
                if (custom) return tag;
                const name = (bracket ?? colon ?? '').toLowerCase();
                if (!name) return '';
                if (seen) return '';
                seen = true;
                return map.get(name) ?? tag;
            },
        );
    }
    return replaced.replace(/ {2,}/g, ' ').trim();
}

/** History-safe version: strips invented tags but keeps known [tags] unresolved
 *  so stored context stays cheap and never leaks raw Discord markup. */
export function sanitizeForHistory(text: string): string {
    if (!text) return text;
    const { tagRe } = getCache();
    const replaced = text.replace(
        tagRe,
        (tag, custom: string, bracket: string, colon: string, _stripBracket: string, _stripColon: string) => {
            if (custom) return tag;
            if ((bracket ?? colon ?? '') !== '') return tag;
            return '';
        },
    );
    return replaced.replace(/ {2,}/g, ' ').trim();
}
