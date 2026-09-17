export type RelationshipStatus =
    | 'stranger'
    | 'friend'
    | 'close_friend'
    | 'bestie'
    | 'enemy'
    | 'lovers';

export interface RelationshipConfig {
    scoring: {
        floor: number;
        ceiling: number;
    };
    decay: {
        graceDays: number;
        daysPerMonth: number;
        monthlyRate: number;
    };
    statusThresholds: {
        enemy: number;
        friend: number;
        closeFriend: number;
        bestie: number;
        lovers: number;
    };
    usage: {
        free: number;
        premium: number;
        voterBonus: number;
    };
    ignore: {
        durationMs: number;
    };
}

export const RELATIONSHIP_CONFIG: RelationshipConfig = {
    scoring: {
        floor: -100,
        ceiling: 100,
    },
    decay: {
        graceDays: 30,
        daysPerMonth: 30,
        monthlyRate: 0.05,
    },
    statusThresholds: {
        enemy: -30,
        friend: 10,
        closeFriend: 40,
        bestie: 70,
        lovers: 85,
    },
    usage: {
        free: 100,
        premium: 200,
        voterBonus: 50,
    },
    ignore: {
        durationMs: 10 * 60 * 1000,
    },
};
