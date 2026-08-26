import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { Users } from '../db/database.js';
import { getUserState, saveUserState, VOTE_FRESH_MS } from '../db/redisStore.js';
import type { UserState } from '../db/redisStore.js';
import { getTopggApi } from '../integrations/TopGG.js';
import { loadEnv } from '../config/env.js';

const PREMIUM_URL = 'https://www.buymeacoffee.com/AliceAI';

const voteUrl = (botId: string): string => `https://top.gg/bot/${botId}/vote`;

let queue: Promise<unknown> = Promise.resolve();

function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(
        () => undefined,
        () => undefined,
    ).then(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
    return run;
}

const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
let failingUntil = 0;

function backoff(reason: string): null {
    failingUntil = Date.now() + FAILURE_BACKOFF_MS;
    console.error(
        `[votes] top.gg unavailable (${reason}) — backing off for ${FAILURE_BACKOFF_MS / 1000}s`,
    );
    return null;
}

/**
 * Vote status via the Top.gg v1 API. Documented semantics: a 404 means the
 * user has not voted / their vote expired — a definitive answer, not an error.
 * Returns null only when top.gg is unreachable or both API generations reject
 * us; callers keep their previous state in that case.
 */
async function queryTopggVote(userId: string): Promise<boolean | null> {
    const now = Date.now();
    if (now < failingUntil) return null;

    const token = loadEnv('DBL_Token');
    if (!token) return false;

    // v1 requires the Bearer prefix; legacy tokens are passed raw.
    const auth = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

    let res: Response;
    try {
        res = await fetch(`https://top.gg/api/v1/projects/@me/votes/${userId}?source=discord`, {
            headers: { Authorization: auth },
        });
    } catch (error) {
        return backoff(error instanceof Error ? error.message : String(error));
    }

    if (res.status === 404) return false;

    if (res.ok) {
        try {
            const data = (await res.json()) as { expires_at?: string };
            return Boolean(data.expires_at && Date.parse(data.expires_at) > now);
        } catch {
            return backoff('malformed v1 response');
        }
    }

    if (res.status === 401 || res.status === 403) {
        // Legacy token without v1 access — fall back to the legacy endpoint.
        const api = getTopggApi();
        if (!api) return false;
        try {
            return await api.hasVoted(userId);
        } catch (error) {
            return backoff(error instanceof Error ? error.message : String(error));
        }
    }

    return backoff(`HTTP ${res.status}`);
}

const inflightVotes = new Map<string, Promise<boolean | null>>();

export function refreshVote(userId: string): Promise<boolean | null> {
    const pending = inflightVotes.get(userId);
    if (pending) return pending;

    const fresh = rateLimited(() => queryTopggVote(userId)).finally(() => {
        if (inflightVotes.get(userId) === fresh) inflightVotes.delete(userId);
    });
    inflightVotes.set(userId, fresh);
    return fresh;
}

export async function checkVoteCached(userId: string, state: UserState): Promise<boolean> {
    if (state.vote && Date.now() - state.vote.checkedAt < VOTE_FRESH_MS) {
        return state.vote.voted;
    }

    const voted = await refreshVote(userId);
    if (voted === null) return state.vote?.voted ?? false;

    try {
        state.vote = { voted, checkedAt: Date.now() };
        await saveUserState(userId, state);
    } catch {
    }

    return voted;
}

export async function checkVote(userId: string): Promise<boolean> {
    let state;
    try {
        state = await getUserState(userId);
    } catch {
        const voted = await rateLimited(() => queryTopggVote(userId));
        return voted ?? false;
    }

    return checkVoteCached(userId, state);
}

export interface VotePrompt {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
}

export async function isVoter(
    userId: string,
    need = 'this feature',
    botId?: string,
): Promise<VotePrompt | null> {
    const user = await Users.get(userId);
    if (user?.tier === 'premium') return null;

    const hasVoted = await checkVote(userId);
    if (hasVoted) return null;

    const embed = new EmbedBuilder()
        .setColor('Gold')
        .setTitle('✨ Vote Required')
        .setDescription(
            '```md\n' +
            '# Unlock Premium Features!\n' +
            `> Vote for Alice to unlock ${need}\n` +
            '> Takes less than a minute\n' +
            '> Unlocks features for 12 hours\n' +
            "> 💎 You wouldn't need to vote if you had Premium!\n" +
            '```',
        )
        .setTimestamp()
        .setFooter({
            text: 'Vote to continue using this feature',
            iconURL: 'https://top.gg/favicon.ico',
        });

    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (botId) {
        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setLabel('Vote on Top.gg')
                    .setStyle(ButtonStyle.Link)
                    .setURL(voteUrl(botId))
                    .setEmoji('⭐'),
            ),
        );
    }
    components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setLabel('💎 Get Premium 💎').setStyle(ButtonStyle.Link).setURL(PREMIUM_URL),
        ),
    );

    return { embeds: [embed], components };
}
