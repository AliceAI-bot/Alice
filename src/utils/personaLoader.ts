import fs from 'fs';
import path from 'path';

let personaCache: string[] | null = null;

export async function getAvailablePersonas(): Promise<string[]> {
    if (personaCache) return personaCache;

    const personaDir = path.join(process.cwd(), 'src/ai/instructions/Persona');
    let files: string[] = [];
    try {
        files = fs.readdirSync(personaDir).filter(f => f.endsWith('.txt'));
    } catch {
        // Missing folder (fresh clone without personas) — not fatal, just empty.
        personaCache = [];
        return personaCache;
    }
    personaCache = files.map(f => f.replace('.txt', ''));
    return personaCache;
}

export function clearPersonaCache(): void {
    personaCache = null;
}