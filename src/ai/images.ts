import type { Message } from 'discord.js';
import type { ChatImage } from '../integrations/google.js';

const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = new Map<string, string>([
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['bmp', 'image/bmp'],
    ['avif', 'image/avif'],
]);

function mimeFromFileName(name: string): string | null {
    return MIME_BY_EXT.get(name.split('.').pop()?.toLowerCase() ?? '') ?? null;
}

/** Eligible attachments (≤2, ≤8MB, image MIME) become inline base64 parts. */
export async function collectImages(message: Message): Promise<{ images: ChatImage[]; failed: number }> {
    const eligible: Array<{ mimeType: string; url: string }> = [];

    for (const attachment of message.attachments.values()) {
        if (eligible.length >= MAX_IMAGES) break;

        const type = attachment.contentType ?? '';
        const looksImage =
            type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(attachment.name);
        if (!looksImage || attachment.size > MAX_IMAGE_BYTES) continue;

        const mimeType = type.startsWith('image/') ? type : mimeFromFileName(attachment.name);
        if (!mimeType) continue;
        eligible.push({ mimeType, url: attachment.url });
    }

    const results = await Promise.allSettled(
        eligible.map(async ({ mimeType, url }) => {
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);

            const buffer = Buffer.from(await res.arrayBuffer());
            return { mimeType, data: buffer.toString('base64') };
        }),
    );

    const images = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    return { images, failed: eligible.length - images.length };
}
