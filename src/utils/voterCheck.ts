import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { loadEnv } from '../config/env.js';
import { Users } from '../db/database.js';
import { getUserState, saveUserState, VOTE_FRESH_MS } from '../db/redisStore.js';
import type { UserState } from '../db/redisStore.js';

const BOT_ID = '1111646562687397928';
  const VOTE_URL = `https://top.gg/bot/${BOT_ID}/vote`;
  const PREMIUM_URL = 'https://www.buymeacoffee.com/AliceAI';

let queue: Promise<unknown> = Promise.resolve();

function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(
        () => undefined,
        () => undefined,
    ).then(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
    return run;
}

export async function queryTopggVote(userId: string): Promise<boolean> {
    try {
        const token = loadEnv('DBL_Token');
        if (!token) return false;

        const res = await fetch(`https://top.gg/api/bots/${BOT_ID}/check?userId=${userId}`, {
            headers: {
                Authorization: token,
                'Content-Type': 'application/json',
            },
        });

        if (!res.ok) {
            console.error(`Vote check failed: ${res.status} - ${res.statusText}`);
            return false;
        }

        const data = (await res.json()) as { voted?: number };
        return data?.voted === 1;
    } catch (error) {
        console.error('Vote check failed:', error);
        return false;
    }
}

const inflightVotes = new Map<string, Promise<boolean>>();

export function refreshVote(userId: string): Promise<boolean> {
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
        return rateLimited(() => queryTopggVote(userId));
    }

    return checkVoteCached(userId, state);
}

export interface VotePrompt {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
}

export async function isVoter(userId: string, need = 'this feature'): Promise<VotePrompt | null> {
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

    const voteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setLabel('Vote on Top.gg')
            .setStyle(ButtonStyle.Link)
            .setURL(VOTE_URL)
            .setEmoji('⭐'),
    );

    const premiumRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('💎 Get Premium 💎').setStyle(ButtonStyle.Link).setURL(PREMIUM_URL),
    );

    return { embeds: [embed], components: [voteRow, premiumRow] };
}
