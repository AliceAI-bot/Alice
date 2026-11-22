import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextChannel,
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    type Client,
    type InteractionReplyOptions,
    type ModalSubmitInteraction,
} from 'discord.js';
import redisClient from '../integrations/redis.js';
import { getLogChannel, isModerator, isOwner } from '../config/config.js';
import { getSession, sessionKey } from '../db/redisStore.js';
import type { SessionMessage } from '../db/redisStore.js';
import { blacklistUser } from './blacklistUtil.js';

const FLAG_DEBOUNCE_MS = 5 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_TRIGGER_PREVIEW = 400;

interface FlagInfo {
    userId: string;
    username: string;
    channelId: string;
    guildId: string | null;
    triggeredContent: string;
    /** HARM_CATEGORY_* values Gemini reported, empty when unknown. */
    categories: string[];
}

export const FLAG_BLACKLIST_PREFIX = 'flag_blacklist:';
export const FLAG_BLACKLIST_MODAL_PREFIX = 'flag_blacklist_modal:';
export const FLAG_CLOSE_PREFIX = 'flag_close:';

/** 'HARM_CATEGORY_HATE_SPEECH' -> 'Hate speech'. */
function prettyCategory(category: string): string {
    return category
        .replace(/^HARM_CATEGORY_/, '')
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function flagReason(info: FlagInfo): string {
    if (!info.categories.length) return 'AI safety filter triggered (high severity)';
    return `AI safety filter — ${info.categories.map(prettyCategory).join(', ')}`;
}

function buildTranscript(info: FlagInfo, session: SessionMessage[]): AttachmentBuilder {
    const lines: string[] = [
        'Alice — flagged content report',
        `Generated : ${new Date().toISOString()}`,
        `Channel   : ${info.guildId ? `${info.guildId} / ${info.channelId}` : `DM ${info.channelId}`}`,
        `User      : ${info.username} (${info.userId})`,
        `Reason    : ${flagReason(info)}`,
        `Triggered : ${info.triggeredContent.replace(/\r?\n/g, ' | ').slice(0, MAX_TRIGGER_PREVIEW)}`,
        '',
        '--- session transcript (oldest -> newest) ---',
    ];
    for (const m of session) {
        const who = m.authorId === info.userId ? `${m.username} (flagged user)` : m.username;
        lines.push(`[${new Date(m.ts).toISOString()}] ${who} (${m.authorId}): ${m.content.replace(/\r?\n/g, ' | ')}`);
    }
    const body = lines.join('\n');
    const text = body.length > MAX_TRANSCRIPT_CHARS
        ? `${body.slice(0, MAX_TRANSCRIPT_CHARS)}\n... (truncated)\n`
        : `${body}\n`;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: `flag-${stamp}.txt` });
}

function buildFlagPayload(client: Client, info: FlagInfo, transcript: AttachmentBuilder) {
    const embed = new EmbedBuilder()
        .setColor(0xff4444)
        .setTitle('🚩 Content Flagged')
        .setDescription(
            [
                '```md',
                '# Safety Trigger',
                `> User: ${info.username} (<@${info.userId}>)`,
                `> Channel: ${info.guildId ? `<#${info.channelId}>` : 'Direct message'}`,
                '```',
            ].join('\n'),
        )
        .addFields(
            { name: 'Reason', value: flagReason(info) },
            { name: 'Triggered Message', value: info.triggeredContent.replace(/\r?\n/g, ' | ').slice(0, MAX_TRIGGER_PREVIEW) || '(empty)' },
        )
        .setThumbnail(client.user?.displayAvatarURL() ?? null)
        .setFooter({ text: 'Alice Safety System • auto-generated' })
        .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${FLAG_BLACKLIST_PREFIX}${info.userId}`)
            .setLabel('🚫 Blacklist User')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${FLAG_CLOSE_PREFIX}${info.userId}`)
            .setLabel('✅ Close')
            .setStyle(ButtonStyle.Secondary),
    );

    return {
        embeds: [embed],
        files: [transcript],
        components: [row],
    };
}

/**
 * Post a safety-triggered chat report to the flagged-content channel with a
 * transcript attachment and Blacklist/Close buttons. Best-effort: never throws,
 * and debounced per user so one churn loop cannot flood the channel.
 */
export async function reportFlaggedContent(client: Client, info: FlagInfo): Promise<void> {
    // Validate the channel first — never burn the 5-min debounce on a bad channel.
    const channelId = getLogChannel('flagged_Content');
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!(channel instanceof TextChannel)) return;

    try {
        // SET NX: null/undefined means a related report is already pending.
        const debounceKey = `flag:${info.userId}`;
        const debounce = await redisClient.set(debounceKey, '1', {
            NX: true,
            PX: FLAG_DEBOUNCE_MS,
        });
        if (!debounce) return; // recent report already pending

        const session = await getSession(sessionKey(info.guildId, info.channelId)).catch(() => []);
        await channel.send(buildFlagPayload(client, info, buildTranscript(info, session)));
    } catch (err) {
        // Release the debounce so the next flag in this window can retry.
        await redisClient.del(`flag:${info.userId}`).catch(() => null);
        console.warn('[flags] reporting flagged content failed:', err instanceof Error ? err.message : err);
    }
}

function deny(): InteractionReplyOptions {
    return { content: 'You need moderator permissions to use this.', flags: 64 };
}

function canModerate(userId: string): boolean {
    return isModerator(userId) || isOwner(userId);
}

/** Locked action row shown on the report after Blacklist/Close is handled. */
const resolveRow = (blacklisted: boolean): ActionRowBuilder<ButtonBuilder> =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${FLAG_BLACKLIST_PREFIX}done`)
            .setLabel(blacklisted ? '✅ User Blacklisted' : '🚫 Blacklist User')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`${FLAG_CLOSE_PREFIX}done`)
            .setLabel('✅ Close')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
    );

async function updateReport(
    interaction: ModalSubmitInteraction | ButtonInteraction,
    note: string,
    blacklisted: boolean,
): Promise<void> {
    const source = interaction.message?.embeds[0];
    const updated = source
        ? new EmbedBuilder(source.data).addFields({ name: '🛡️ Action', value: note })
        : null;
    await interaction.editReply({
        embeds: updated ? [updated] : [],
        components: [resolveRow(blacklisted)],
    }).catch(() => null);
}

function buildBlacklistModal(userId: string, prefill: string): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(`${FLAG_BLACKLIST_MODAL_PREFIX}${userId}`)
        .setTitle('Blacklist User')
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('flag_blacklist_reason')
                    .setLabel('Reason (goes to the user, report and logs)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(prefill.slice(0, 1000))
                    .setMinLength(3)
                    .setMaxLength(1000)
                    .setRequired(true),
            ),
        );
}

/** Modal submit on the report's Blacklist button — the mod wrote the reason. */
export async function handleFlagBlacklistModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!canModerate(interaction.user.id)) {
        await interaction.reply(deny()).catch(() => null);
        return;
    }

    const raw = interaction.customId.slice(FLAG_BLACKLIST_MODAL_PREFIX.length);
    const reason = interaction.fields.getTextInputValue('flag_blacklist_reason').trim() || 'AI safety violation';

    await interaction.deferUpdate().catch(() => null);

    if (raw === 'done' || !/^\d{5,25}$/.test(raw)) {
        await interaction.editReply({ components: [resolveRow(true)] }).catch(() => null);
        return;
    }

    const outcome = await blacklistUser({
        client: interaction.client,
        userId: raw,
        reason,
        moderatorTag: interaction.user.tag,
        moderatorId: interaction.user.id,
    });
    const note = outcome.added
        ? `🛡️ User blacklisted by ${interaction.user.tag} — reason: ${reason}`
        : `⚠️ User was already blacklisted (reason: ${outcome.existingReason || 'unknown'}) — no action taken`;
    await updateReport(interaction, note, true);
}

/** Blacklist/Close buttons on flag reports — moderators and devs only. */
export async function handleFlagButton(interaction: ButtonInteraction): Promise<void> {
    if (!canModerate(interaction.user.id)) {
        await interaction.reply(deny()).catch(() => null);
        return;
    }

    const isBlacklist = interaction.customId.startsWith(FLAG_BLACKLIST_PREFIX);
    const prefix = isBlacklist ? FLAG_BLACKLIST_PREFIX : FLAG_CLOSE_PREFIX;
    const raw = interaction.customId.slice(prefix.length);

    if (raw === 'done') {
        await interaction.deferUpdate().catch(() => null);
        return;
    }

    if (isBlacklist) {
        const reason =
            interaction.message.embeds[0]?.fields.find((f) => f.name === 'Reason')?.value?.trim()
            || 'AI safety violation';
        await interaction.showModal(buildBlacklistModal(raw, reason)).catch(() => null);
        return;
    }

    await interaction.deferUpdate();
    await updateReport(interaction, `✅ Closed by ${interaction.user.tag}`, false);
}
