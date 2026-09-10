import { RELATIONSHIP_CONFIG } from '../config/relationshipConfig.js';
import type { RelationshipConfig, RelationshipStatus } from '../config/relationshipConfig.js';

export type {
    RelationshipStatus,
    RelationshipConfig,
} from '../config/relationshipConfig.js';

const VALID_STATUSES: ReadonlySet<string> = new Set<RelationshipStatus>([
    'stranger',
    'friend',
    'close_friend',
    'bestie',
    'enemy',
    'lovers',
]);

const LEGACY_STATUS_MAP: ReadonlyMap<string, RelationshipStatus> = new Map([
    ['married', 'lovers'],
]);

export interface RelationshipState {
    affection: number;
    status: RelationshipStatus;
    lastEmotion: string | null;
    lastInteractionAt: number | null;
    sinceAt: number | null;
}

export function createRelationship(): RelationshipState {
    return {
        affection: 0,
        status: 'stranger',
        lastEmotion: null,
        lastInteractionAt: null,
        sinceAt: null,
    };
}

export function normalizeRelationship(raw: unknown): RelationshipState {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const rawStatus = typeof r.status === 'string' ? r.status : '';
    const legacy = LEGACY_STATUS_MAP.get(rawStatus);
    const status = VALID_STATUSES.has(rawStatus)
        ? (rawStatus as RelationshipStatus)
        : legacy ?? 'stranger';

    return {
        affection: typeof r.affection === 'number' ? r.affection : 0,
        status,
        lastEmotion: typeof r.lastEmotion === 'string' && r.lastEmotion ? r.lastEmotion : null,
        lastInteractionAt: typeof r.lastInteractionAt === 'number' ? r.lastInteractionAt : null,
        sinceAt: typeof r.sinceAt === 'number' ? r.sinceAt : null,
    };
}

export function clamp(min: number, max: number, value: number): number {
    return value < min ? min : value > max ? max : value;
}

export function roundAffection(value: number): number {
    return Math.round(value * 10) / 10;
}

export function deriveStatus(
    affection: number,
    config: RelationshipConfig = RELATIONSHIP_CONFIG,
): RelationshipStatus {
    const t = config.statusThresholds;
    if (affection <= t.enemy) return 'enemy';
    if (affection < t.friend) return 'stranger';
    if (affection < t.closeFriend) return 'friend';
    if (affection < t.bestie) return 'close_friend';
    if (affection < t.lovers) return 'bestie';
    return 'lovers';
}

export interface DecayResult {
    rel: RelationshipState;
    decayed: boolean;
}

const MS_PER_DAY = 86_400_000;

export function applyMonthlyDecay(
    rel: RelationshipState,
    now = Date.now(),
    config: RelationshipConfig = RELATIONSHIP_CONFIG,
): DecayResult {
    const { graceDays, daysPerMonth, monthlyRate } = config.decay;
    const idleMs = rel.lastInteractionAt == null ? 0 : now - rel.lastInteractionAt;
    const graceMs = graceDays * MS_PER_DAY;

    if (idleMs <= graceMs || rel.affection === 0) return { rel, decayed: false };

    const months = (idleMs - graceMs) / (daysPerMonth * MS_PER_DAY);
    const factor = Math.pow(1 - monthlyRate, months);

    return {
        rel: {
            ...rel,
            affection: clamp(config.scoring.floor, config.scoring.ceiling, rel.affection * factor),
        },
        decayed: true,
    };
}

const STATUS_CONTEXT: Record<RelationshipStatus, string> = {
    stranger:
        'You and {user} are strangers. Keep a little distance — polite but not warm yet, no pet names, no inside jokes. Earn closeness, don\'t assume it.',
    friend:
        'You and {user} are friends. Relaxed and approachable, light teasing ok, occasional hype. Friendly, not clingy.',
    close_friend:
        'You and {user} are close friends. Comfortable and trusting — you can be honest, roast a little, remember small things, check in for real.',
    bestie:
        'You and {user} are besties. High familiarity, playful chaos, inside-joke energy. You notice their mood fast and call it out gently.',
    enemy:
        'You and {user} are on bad terms. Guarded, dry, short. Don\'t fawn, don\'t start fights either — they have to earn their way back.',
    lovers:
        'You and {user} are lovers. Warm, soft, a little clingy-cute. Affectionate but still you — teasing, jealous-pouty, real, never soppy-essay.',
};

export function affectionBand(affection: number): string {
    if (!Number.isFinite(affection)) return 'lukewarm';
    if (affection <= -30) return 'ice-cold';
    if (affection < 10) return 'lukewarm';
    if (affection < 40) return 'warm';
    if (affection < 70) return 'close';
    if (affection < 85) return 'tight';
    return 'devoted';
}

export function buildRelationshipContext(status: RelationshipStatus, affection?: number): string {
    const base = STATUS_CONTEXT[status] ?? STATUS_CONTEXT.stranger!;
    if (typeof affection === 'number' && Number.isFinite(affection)) {
        return `${base} Bond: ${affectionBand(affection)} (${Math.round(affection)}/100).`;
    }
    return base;
}

export function formatTimeGap(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return 'first time talking';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    if (days < 30) {
        const weeks = Math.floor(days / 7);
        return weeks <= 1 ? 'a week ago' : `${weeks}w ago`;
    }
    const months = Math.floor(days / 30);
    return months <= 1 ? 'a month ago' : `${months}mo ago`;
}

let hourFmt: Intl.DateTimeFormat | null = null;
let fullFmt: Intl.DateTimeFormat | null = null;

function getHourFmt(): Intl.DateTimeFormat {
    if (!hourFmt) {
        hourFmt = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric',
            hour12: false,
            timeZone: 'Asia/Tokyo',
        });
    }
    return hourFmt;
}

function getFullFmt(): Intl.DateTimeFormat {
    if (!fullFmt) {
        fullFmt = new Intl.DateTimeFormat('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Tokyo',
        });
    }
    return fullFmt;
}

export function daypartTokyo(date = new Date()): string {
    const hourStr = getHourFmt().format(date);
    const hour = Number.parseInt(hourStr, 10);
    if (Number.isNaN(hour)) return 'daytime';
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 22) return 'evening';
    if (hour >= 22 || hour < 2) return 'night';
    return 'late-night';
}

export function formatTokyoNow(date = new Date()): string {
    try {
        return `${getFullFmt().format(date)} JST (${daypartTokyo(date)})`;
    } catch {
        return date.toISOString();
    }
}

/** Lingering mood so emotion doesn't snap-reset every turn. Fades with idle time. */
export function buildMoodLine(
    lastEmotion: string | null | undefined,
    lastInteractionAt: number | null | undefined,
    now = Date.now(),
): string {
    if (!lastEmotion) return '';
    if (lastEmotion === 'neutral') return '';
    if (lastInteractionAt == null) return `You were feeling ${lastEmotion} recently — carry it lightly unless they changed the vibe.`;
    const idle = now - lastInteractionAt;
    if (idle < 15 * 60 * 1000) return `You're still feeling ${lastEmotion} from a moment ago — don't snap-reset unless they changed the vibe.`;
    if (idle < 2 * 60 * 60 * 1000) return `A little ${lastEmotion} is still lingering — soften it unless they keep the same energy.`;
    if (idle < 12 * 60 * 60 * 1000) return `Faint echo of feeling ${lastEmotion} earlier — mostly fresh now.`;
    return '';
}
