// Out-of-model fallback copy.
// Error + quota replies are embeds (see utils/embeds.ts) — this module is only
// for short text nudges where an embed would be noisy (per-message cooldown).

const COOLDOWN_LINES = [
    'one sec — still finishing your last message',
    'give me a moment, almost done',
    'just a second, one thing at a time',
];

const BLOCKED_LINES = [
    'i… cant really respond to that one',
    'nah, im not touching that one, sorry',
    "that ones a no from me, sorry",
];

function pick(lines: readonly string[]): string {
    return lines[Math.floor(Math.random() * lines.length)]!;
}

export function cooldownLine(): string {
    return pick(COOLDOWN_LINES);
}

/** Safety-block nudge — plain in-character text, no embed. */
export function blockedLine(): string {
    return pick(BLOCKED_LINES);
}
