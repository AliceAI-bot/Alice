import fs from 'fs';
import path from 'path';

let personaCache: string[] | null = null;

function personaDir(): string {
    return path.join(process.cwd(), 'src', 'ai', 'instructions', 'Persona');
}

export async function getAvailablePersonas(): Promise<string[]> {
    if (personaCache) return personaCache;

    let files: string[] = [];
    try {
        files = fs.readdirSync(personaDir()).filter((f) => f.toLowerCase().endsWith('.txt'));
    } catch {
        // Missing folder (fresh clone without personas) — not fatal, just empty.
        personaCache = [];
        return personaCache;
    }
    personaCache = files.map((f) => f.replace(/\.txt$/i, ''));
    return personaCache;
}