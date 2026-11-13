import { ThinkingLevel } from '@google/genai';
import { chat } from '../integrations/google.js';
import {
    saveSessionSummary,
    trimSessionToTail,
    SESSION_MAX_MESSAGES,
    SESSION_MODEL_WINDOW,
} from '../db/redisStore.js';
import type { SessionMessage, SessionSummary } from '../db/redisStore.js';

/**
 * Rolling append-only summary (fire-and-forget, never blocks replies).
 * Desired behavior: shared channel holds max 30 msgs. When it hits 30, we
 * summarize ONLY the old head (oldest len-14), delete those texts from Redis
 * (keep live tail 14), and APPEND the new chunk to the existing summary.
 * The prior summary is never re-summarized — it is preserved verbatim.
 */
const SUMMARY_TRIGGER_LEN = SESSION_MAX_MESSAGES;
const SUMMARY_MAX_TEXT = 1200;

function parseSummarySections(text: string): { facts: string[]; vibe: string; loops: string[] } {
    const facts: string[] = [];
    let vibe = '';
    const loops: string[] = [];
    let section: 'facts' | 'vibe' | 'loops' | null = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (/^FACTS:/i.test(line)) {
            section = 'facts';
            const rest = line.replace(/^FACTS:/i, '').trim();
            if (rest) facts.push(rest);
            continue;
        }
        if (/^VIBE:/i.test(line)) {
            section = 'vibe';
            vibe = line.replace(/^VIBE:/i, '').trim();
            continue;
        }
        if (/^LOOPS:/i.test(line)) {
            section = 'loops';
            continue;
        }
        if (!line) continue;
        const clean = line.replace(/^[-•*\d.)\s]+/, '').trim();
        if (!clean) continue;
        if (section === 'facts' && facts.length < 5) facts.push(clean);
        else if (section === 'vibe' && !vibe) vibe = clean;
        else if (section === 'loops' && loops.length < 3) loops.push(clean);
    }
    return { facts: facts.slice(0, 5), vibe: vibe.slice(0, 200), loops: loops.slice(0, 3) };
}

export async function maybeSummarize(
    key: string,
    fullSession: SessionMessage[],
    existing: SessionSummary | null,
    byokKey?: string,
): Promise<void> {
    try {
        if (fullSession.length < SUMMARY_TRIGGER_LEN) return;
        // Old head only — never the prior summary. Tail stays live in Redis.
        const head = fullSession.slice(0, fullSession.length - SESSION_MODEL_WINDOW);
        if (head.length < 8) return;
        // Skip anything already covered (crash/race safety) — watermark only moves forward.
        const coveredUpTo = existing?.coveredUpTo ?? 0;
        const fresh = head.filter((m) => m.ts > coveredUpTo);
        if (fresh.length < 8) {
            // Still trim already-covered head so the list can't stick at 30 forever.
            if (head.length >= fullSession.length - SESSION_MODEL_WINDOW) {
                await trimSessionToTail(key, SESSION_MODEL_WINDOW);
            }
            return;
        }

        const transcript = fresh
            .map((m) => `${m.username}: ${m.content}`.slice(0, 280))
            .join('\n')
            .slice(0, 4500);
        const { text } = await chat({
            system: 'Summarize this chat excerpt, no inventing. Reply EXACTLY:\nFACTS:\n- ... (up to 5)\nVIBE: ... (1 line)\nLOOPS:\n- ... (up to 3)',
            messages: [{ role: 'user', content: `Summarize:\n${transcript}` }],
            temperature: 0.3,
            maxTokens: 300,
            thinking: ThinkingLevel.MINIMAL,
            ...(byokKey ? { apiKey: byokKey } : {}),
        });
        const { facts, vibe, loops } = parseSummarySections(text);
        if (!facts.length && !vibe) return;
        const chunk = [
            facts.length ? `FACTS:\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
            vibe ? `VIBE: ${vibe}` : '',
        ]
            .filter(Boolean)
            .join('\n');
        // Append-only: preserve prior summary verbatim, add new chunk, cap tail.
        const base = existing?.text?.trim() ?? '';
        const appended = base ? `${base}\n---\n${chunk}` : chunk;
        const capped =
            appended.length <= SUMMARY_MAX_TEXT
                ? appended
                : appended.slice(appended.length - SUMMARY_MAX_TEXT);
        const mergedLoops = [...(existing?.openLoops ?? []), ...loops].slice(-5);
        await saveSessionSummary(key, {
            text: capped,
            openLoops: mergedLoops,
            updatedAt: Date.now(),
            coveredUpTo: head[head.length - 1]?.ts ?? Date.now(),
        });
        // Delete old texts from Redis — summary now carries them. Keep live tail.
        await trimSessionToTail(key, SESSION_MODEL_WINDOW);
    } catch (err) {
        console.warn('[ai] background summary failed:', err instanceof Error ? err.message : err);
    }
}
