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
    stranger: 'You and {user} are strangers. Be unfamiliar and polite.',
    friend: 'You and {user} are friends. Be friendly and approachable.',
    close_friend: 'You and {user} are close friends. Be comfortable and trusting.',
    bestie: 'You and {user} are best friends. Be highly familiar and playful.',
    enemy: 'You and {user} are enemies. Be guarded and distant.',
    lovers: 'You and {user} are lovers. Be warm and affectionate.',
};

export function buildRelationshipContext(status: RelationshipStatus): string {
    return STATUS_CONTEXT[status] ?? STATUS_CONTEXT.stranger!;
}
