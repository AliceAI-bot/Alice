// Single home for Alice's out-of-model fallback lines (kept in-voice: lowercase, no "!").

const BUSY_LINES = [
    "mm sorry my head's spinning a little rn, say that again",
    'ugh laggy brain sorry, one more time',
    'wait i zoned out lol what was that',
];

const COOLDOWN_LINES = [
    'slowww down lol one sec',
    'wait wait one thing at a time',
    'hold on gimme a sec',
];

function pick(lines: readonly string[]): string {
    return lines[Math.floor(Math.random() * lines.length)]!;
}

export function busyLine(): string {
    return pick(BUSY_LINES);
}

export function cooldownLine(): string {
    return pick(COOLDOWN_LINES);
}

export function quotaLine(quota: number, bonus: number): string {
    return pick([
        `outta messages for today lol (${quota}), vote and i get +${bonus} more for you`,
        `daily limit hit (${quota}) ugh, voting gives +${bonus} if you want more`,
        `no more replies today (${quota}) sorryy, vote = +${bonus} bonus ones`,
    ]);
}
