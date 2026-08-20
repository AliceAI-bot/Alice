const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const FREE_MODEL = 'openrouter/free';

export interface KeyCheckResult {
    valid: boolean;
    error?: string;
}

export async function keycheck(apiKey: string): Promise<KeyCheckResult> {
    if (!apiKey || !apiKey.trim()) {
        return { valid: false, error: 'No API key provided.' };
    }

    try {
        const res = await fetch(OPENROUTER_API, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: FREE_MODEL,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            }),
        });

        if (res.status === 200) return { valid: true };

        if (res.status === 401 || res.status === 403) {
            return { valid: false, error: 'Invalid API key. Double-check it on https://openrouter.ai/keys.' };
        }

        if (res.status === 429) {
            return { valid: false, error: 'Rate limited by OpenRouter, try again in a moment.' };
        }

        const body = await res.json().catch(() => null);
        const message = (body as any)?.error?.message;
        return { valid: false, error: message ?? `Request failed with status ${res.status}.` };
    } catch {
        return { valid: false, error: 'Could not reach OpenRouter, try again later.' };
    }
}