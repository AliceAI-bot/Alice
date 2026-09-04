import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { Users } from '../db/database.js';
import { getUserState, saveUserState, VOTE_FRESH_MS } from '../db/redisStore.js';
import type { UserState } from '../db/redisStore.js';
import { loadEnv } from '../config/env.js';

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
 * Returns null only when top.gg is unreachable or the token is rejected;
 * callers keep their previous state in that case.
 * Requires a current (v1) project token sent as `Bearer`; legacy tokens
 * no longer work for vote checks.
 */
async function queryTopggVote(userId: string): Promise<boolean | null> {
    const now = Date.now();
    if (now < failingUntil) return null;

    const token = loadEnv('DBL_Token');
    if (!token) {
        console.warn('[votes] DBL_Token missing — treating as not voted');
        return false;
    }

    // v1 requires the Bearer prefix.
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
        return backoff(`invalid top.gg token (HTTP ${res.status})`);
    }

    if (res.status === 429) {
        return backoff('rate limited (HTTP 429)');
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

    return { embeds: [embed], components };
}
