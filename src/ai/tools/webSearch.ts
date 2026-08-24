import { groundedSearch } from '../../integrations/google.js';

export const WEB_SEARCH_TOOL = 'web_search';

const MAX_SOURCES = 3;

export async function executeWebSearch(query: unknown, apiKey?: string): Promise<string> {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return 'No search query was provided.';

    try {
        const { text, sources } = await groundedSearch(q, apiKey);
        if (!text.trim()) return 'No useful results found.';

        const citations = sources
            .slice(0, MAX_SOURCES)
            .map((s) => `- ${s.title || s.uri}: ${s.uri}`)
            .join('\n');

        return citations ? `${text.trim()}\n\nSources:\n${citations}` : text.trim();
    } catch (err) {
        console.error('[ai] web_search failed:', err);
        return 'Web search is unavailable right now.';
    }
}
