/**
 * Natural-language reminder time parsing.
 *
 * Pure module (no imports, no side effects) so it can be tested in isolation.
 * Handles relative durations ("in 10m", "1h30m", "half an hour") plus the
 * common absolute shapes ("tomorrow at 9am", "at 5pm", "on Friday", "tonight").
 * Absolute times resolve in Asia/Tokyo, matching the "Right now: ... JST"
 * line the model sees in its context prompt. Japan has no DST, so the
 * JST offset is a fixed +9h.
 */

export const REMINDER_MIN_DELAY_MS = 60_000;
export const REMINDER_MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

const JST_MS = 9 * 60 * 60 * 1000;

const NUM_UNIT_RE =
    /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])/gi;
const HALF_HOUR_RE = /half\s+an?\s+hour/i;
const QUARTER_HOUR_RE = /quarter\s+(?:of\s+an?\s+)?hour/i;
const COUPLE_RE = /a\s+couple\s+(?:of\s+)?(seconds?|minutes?|hours?|days?)/i;
const FEW_RE = /\b(?:a\s+)?few\s+(seconds?|minutes?|hours?|days?)/i;
const WORD_UNIT_RE = /an?\s+(second|minute|hour|day)s?/i;

function unitToMs(unit: string): number {
    const u = unit[0]!.toLowerCase();
    if (u === 's') return 1000;
    if (u === 'm') return 60_000;
    if (u === 'h') return 3_600_000;
    return 86_400_000;
}

/**
 * Relative durations. Sums every <number><unit> pair so compounds like
 * "1 hour 30 minutes" / "1h30m" just work. Falls back to fuzzy shapes
 * ("half an hour", "a couple hours", "a few minutes", "an hour").
 */
function parseDurationMs(raw: string): number | null {
    let total = 0;
    NUM_UNIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NUM_UNIT_RE.exec(raw)) !== null) {
        const n = Number.parseFloat(m[1]!);
        if (!Number.isFinite(n) || n <= 0) continue;
        total += Math.round(n * unitToMs(m[2]!));
    }
    if (total > 0) return total;
    if (HALF_HOUR_RE.test(raw)) return 30 * 60_000;
    if (QUARTER_HOUR_RE.test(raw)) return 15 * 60_000;
    const couple = raw.match(COUPLE_RE);
    if (couple) return 2 * unitToMs(couple[1]!);
    const few = raw.match(FEW_RE);
    if (few) return 3 * unitToMs(few[1]!);
    const word = raw.match(WORD_UNIT_RE);
    if (word) return unitToMs(word[1]!);
    return null;
}

interface JstWall {
    y: number;
    mo: number;
    d: number;
    h: number;
    mi: number;
    wd: number;
}

function jstWall(now: number): JstWall {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo',
        weekday: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    });
    const parts = dtf.formatToParts(new Date(now));
    const get = (t: string): number => Number.parseInt(parts.find((p) => p.type === t)?.value ?? '', 10);
    const wdStr = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        y: get('year'),
        mo: get('month'),
        d: get('day'),
        h: get('hour') % 24,
        mi: get('minute'),
        wd: wdMap[wdStr] ?? 0,
    };
}

function epochFromJST(y: number, mo: number, d: number, h: number, mi: number): number {
    return Date.UTC(y, mo - 1, d, h, mi) - JST_MS;
}

/** Clock time like "at 5pm", "at 17:30", "9am". Bare numbers don't count. */
function parseClockTime(raw: string): { h: number; mi: number } | null {
    const m = raw.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
    if (!m) return null;
    if (!/\bat\b/i.test(raw) && m[3] === undefined) return null;
    let h = Number.parseInt(m[1]!, 10);
    const mi = m[2] !== undefined ? Number.parseInt(m[2]!, 10) : 0;
    if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return null;
    const mer = (m[3] ?? '').toLowerCase();
    if (mer.startsWith('p') && h < 12) h += 12;
    if (mer.startsWith('a') && h === 12) h = 0;
    if (h === 24) h = 0;
    return { h, mi };
}

const WEEKDAYS: Array<{ re: RegExp; wd: number }> = [
    { re: /\bsun(?:day)?\b/i, wd: 0 },
    { re: /\bmon(?:day)?\b/i, wd: 1 },
    { re: /\btue(?:sday)?\b/i, wd: 2 },
    { re: /\bwed(?:nesday)?\b/i, wd: 3 },
    { re: /\bthu(?:rsday)?\b/i, wd: 4 },
    { re: /\bfri(?:day)?\b/i, wd: 5 },
    { re: /\bsat(?:urday)?\b/i, wd: 6 },
];

/**
 * Absolute times in JST: "tomorrow [at H]", "tonight", "this morning/
 * afternoon/evening", weekday names, "next week", "at H[am/pm]".
 * Returns an epoch-ms fire time, or null when nothing matches.
 */
function parseAbsoluteJST(raw: string, now: number): number | null {
    const p = jstWall(now);
    if (!Number.isFinite(p.y) || !Number.isFinite(p.mo) || !Number.isFinite(p.d)) return null;
    const midnight = epochFromJST(p.y, p.mo, p.d, 0, 0);
    const at = (dayOffset: number, h: number, mi: number): number =>
        midnight + dayOffset * 86_400_000 + h * 3_600_000 + mi * 60_000;
    const clock = parseClockTime(raw);

    if (/\btomorrow\b/i.test(raw)) {
        const t = clock ?? { h: 9, mi: 0 };
        return at(1, t.h, t.mi);
    }
    if (/\btonight\b/i.test(raw)) {
        const c = at(0, 22, 0);
        return c - now >= REMINDER_MIN_DELAY_MS ? c : now + 60 * 60_000;
    }
    const daypart = raw.match(/\bthis\s+(morning|afternoon|evening)\b/i);
    if (daypart) {
        const w = daypart[1]!.toLowerCase();
        const c = at(0, w === 'morning' ? 8 : w === 'afternoon' ? 13 : 19, 0);
        return c - now >= REMINDER_MIN_DELAY_MS ? c : null;
    }
    for (const w of WEEKDAYS) {
        if (w.re.test(raw)) {
            const t = clock ?? { h: 9, mi: 0 };
            let deltaDays = (w.wd - p.wd + 7) % 7;
            if (deltaDays === 0 && at(0, t.h, t.mi) - now < REMINDER_MIN_DELAY_MS) deltaDays = 7;
            return at(deltaDays, t.h, t.mi);
        }
    }
    if (/\bnext\s+week\b/i.test(raw)) return now + 7 * 86_400_000;
    if (clock) {
        const c = at(0, clock.h, clock.mi);
        return c - now >= REMINDER_MIN_DELAY_MS ? c : c + 86_400_000;
    }
    return null;
}

/**
 * Resolve a human time expression to an epoch-ms fire time.
 * Accepts durations ("in 10m", "1h30m", "half an hour") and common JST
 * absolute times ("tomorrow at 9am", "at 5pm", "on Friday", "tonight").
 * Returns null when unparseable or outside the 1m–7d window.
 */
export function parseReminderWhen(raw: unknown, now = Date.now()): number | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const dur = parseDurationMs(raw);
    if (dur !== null) {
        if (dur < REMINDER_MIN_DELAY_MS || dur > REMINDER_MAX_DELAY_MS) return null;
        return now + dur;
    }
    const abs = parseAbsoluteJST(raw, now);
    if (abs === null) return null;
    if (abs - now < REMINDER_MIN_DELAY_MS || abs - now > REMINDER_MAX_DELAY_MS) return null;
    return abs;
}
