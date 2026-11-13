/** Discord's hard cap for a single message. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** Split at newline/space, never mid-token; output is always under the cap. */
function splitHard(content: string): string[] {
    if (content.length <= DISCORD_MESSAGE_LIMIT) return [content];

    const parts: string[] = [];
    let remaining = content;
    while (remaining.length > DISCORD_MESSAGE_LIMIT) {
        const window = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
        let cut = window.lastIndexOf('\n');
        if (cut <= 0) cut = window.lastIndexOf(' ');
        if (cut <= 0) cut = DISCORD_MESSAGE_LIMIT;

        parts.push(remaining.slice(0, cut).trimEnd());
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.length) parts.push(remaining);
    return parts;
}

/**
 * Human texting split: 1 bubble by default. A blank line is an explicit
 * model-authored break -> 2 bubbles max. Never more than 2.
 */
export function splitBubbles(content: string): string[] {
    const text = content.replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    // Model-authored break wins over every heuristic below.
    const authored = text.indexOf('\n\n');
    if (authored > 0 && authored < text.length - 2) {
        const parts = [text.slice(0, authored).trim(), text.slice(authored + 2).trim()].filter(Boolean);
        if (parts.length === 2) return parts.flatMap(splitHard).slice(0, 2);
    }
    if (text.length <= 280) return splitHard(text);
    if (text.length > DISCORD_MESSAGE_LIMIT) return splitHard(text);

    // Prefer a paragraph break, else a sentence boundary near the middle.
    const para = text.indexOf('\n\n');
    if (para > 60 && para < text.length - 60) {
        return [text.slice(0, para).trim(), text.slice(para + 2).trim()].flatMap(splitHard);
    }
    const mid = Math.floor(text.length / 2);
    let best = -1;
    const sentenceRe = /[.!?…]\s/g;
    let m: RegExpExecArray | null;
    while ((m = sentenceRe.exec(text)) !== null) {
        const idx = m.index + m[0].length;
        if (idx < 60 || idx > text.length - 60) continue;
        if (best === -1 || Math.abs(idx - mid) < Math.abs(best - mid)) best = idx;
    }
    if (best !== -1) {
        return [text.slice(0, best).trim(), text.slice(best).trim()].flatMap(splitHard);
    }
    return splitHard(text).slice(0, 2);
}
