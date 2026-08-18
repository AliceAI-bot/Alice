import fs from 'fs';
import path from 'path';

let personaCache: string[] | null = null;

export async function getAvailablePersonas(): Promise<string[]> {
    if (personaCache) return personaCache;

    const personaDir = path.join(process.cwd(), 'src/ai/instructions/Persona');
    const files = fs.readdirSync(personaDir).filter(f => f.endsWith('.txt'));
    personaCache = files.map(f => f.replace('.txt', ''));
    return personaCache;
}

export function clearPersonaCache(): void {
    personaCache = null;
}