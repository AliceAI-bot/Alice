import type { Client } from 'discord.js';
import redisClient from '../../integrations/redis.js';
import type { ToolContext } from '../../types/ai.js';
import { parseReminderWhen } from './reminderTime.js';

export { parseReminderWhen } from './reminderTime.js';

export const REMIND_TOOL = 'create_reminder';

const REMINDERS_KEY = 'reminders';
const MAX_PER_USER = 3;
const MAX_TEXT = 200;

interface StoredReminder {
    userId: string;
    text: string;
    nonce: string;
    channelId?: string;
}

export async function executeRemind(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const text = typeof args.text === 'string' ? args.text.trim().slice(0, MAX_TEXT) : '';
    if (!text) return 'No reminder text given.';
    const fireAt = parseReminderWhen(args.when);
    if (fireAt === null) return 'Alice needs a time like "in 10m", "in 2h", "tomorrow at 9am" or "at 5pm" (1m–7d). Ask them.';

    try {
        const all = await redisClient.zRangeByScore(REMINDERS_KEY, '-inf', '+inf');
        let mine = 0;
        for (const member of all) {
            try {
                if ((JSON.parse(member) as StoredReminder).userId === ctx.requesterId) mine++;
            } catch {
                // Corrupt member — swept below.
            }
        }
        if (mine >= MAX_PER_USER) return 'They already have 3 reminders pending — say that, gently.';
        const nonce = `${Date.now()}:${Math.floor(Math.random() * 1_000_000_000)}`;
        const member = JSON.stringify({
            userId: ctx.requesterId,
            text,
            nonce,
            channelId: ctx.message.channelId,
        } satisfies StoredReminder);
        await redisClient.zAdd(REMINDERS_KEY, [{ score: fireAt, value: member }]);
        // Key safety net: members carry fireAt, but never let the key live forever if sweeping stalls.
        await redisClient.expire(REMINDERS_KEY, 8 * 24 * 60 * 60);
        return `Reminder set for <t:${Math.floor(fireAt / 1000)}:R>. Confirm it casually in your reply.`;
    } catch {
        return 'Reminders are unavailable right now — say that briefly.';
    }
}

let sweeping = false;

/** DM delivery loop. Safe under sharding: whoever ZREMs first wins, others skip. */
export function startReminderSweeper(client: Client): void {
    const clusterId = (client as { cluster?: { id?: number } }).cluster?.id;
    if (clusterId !== undefined && clusterId !== 0) return;

    const tick = async () => {
        if (sweeping) return;
        sweeping = true;
        try {
            const due = await redisClient.zRangeByScore(REMINDERS_KEY, '-inf', String(Date.now()));
            for (const member of due) {
                const removed = await redisClient.zRem(REMINDERS_KEY, member).catch(() => 0);
                if (!removed) continue;
                let parsed: StoredReminder | null = null;
                try {
                    parsed = JSON.parse(member) as StoredReminder;
                } catch {
                    continue;
                }
                if (!parsed?.userId || !parsed.text) continue;
                const body = `hey reminder: ${parsed.text}`.slice(0, 400);
                try {
                    const user = await client.users.fetch(parsed.userId);
                    await user.send(body);
                } catch {
                    // DMs closed — fall back to the original channel so the
                    // reminder isn't silently lost. Old rows without a
                    // channelId still just drop.
                    if (!parsed.channelId) continue;
                    try {
                        const channel = await client.channels.fetch(parsed.channelId).catch(() => null);
                        const sendable = channel as unknown as {
                            isSendable?: () => boolean;
                            send?: (content: string) => Promise<unknown>;
                        } | null;
                        if (!sendable || typeof sendable.send !== 'function') continue;
                        if (typeof sendable.isSendable === 'function' && !sendable.isSendable()) continue;
                        await sendable.send(`<@${parsed.userId}> ${body}`);
                    } catch {
                        // Channel gone/inaccessible — drop it, don't retry.
                    }
                }
            }
        } catch (err) {
            console.warn('[reminders] sweep failed:', err instanceof Error ? err.message : err);
        } finally {
            sweeping = false;
        }
    };

    const timer = setInterval(() => void tick(), 20_000);
    timer.unref?.();
    void tick();
}
