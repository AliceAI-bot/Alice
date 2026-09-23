import { Events, Interaction, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js'; import { CustomClient } from '../bot/client.js'; import { createTosEmbed, handleTosButton } from '../utils/tos.js'; import { Users } from '../db/database.js'; import { buildBlacklistResponse } from '../utils/blacklistUtil.js'; import { handleByokButton, handleByokModal } from '../commands/byok.js'; import type { Event, Command } from '../types/index.js';

export default {
    name: Events.InteractionCreate,
    async execute(interaction: Interaction, client: CustomClient): Promise<void> {
        if (interaction.isButton()) {
            // The ToS buttons ARE the acceptance flow — everything else is gated.
            if (interaction.customId === 'accept_tos' || interaction.customId === 'cancel_tos') {
                await handleTosButton(interaction as ButtonInteraction);
                return;
            }
            if (await isBlocked(interaction)) return;
            if (interaction.customId.startsWith('byok_add') || interaction.customId.startsWith('byok_remove')) {
                await handleByokButton(interaction as ButtonInteraction);
                return;
            }
            return;
        }
        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'byok_modal') {
                if (await isBlocked(interaction)) return;
                await handleByokModal(interaction);
                return;
            }
            return;
        }
        if (interaction.isAutocomplete()) {
            const command = client.slashCommands.get(interaction.commandName) as Command | undefined;
            if (!command?.autocomplete) return;

            try {
                await command.autocomplete(interaction);
            } catch (error) {
                console.error(`Autocomplete error (${interaction.commandName}):`, error);
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        const command = client.slashCommands.get(interaction.commandName) as Command | undefined;
        if (!command) return;

        if (await isBlocked(interaction)) return;

        const cooldownKey = `${interaction.user.id}:${interaction.commandName}`;
        const now = Date.now();
        const cooldownDuration = (command.cooldown ?? 3) * 1000;
        const expirationTime = client.cooldowns.get(cooldownKey);

        if (expirationTime && now < expirationTime) {
            const timeLeft = ((expirationTime - now) / 1000).toFixed(1);
            await interaction.reply({
                content: `Please wait ${timeLeft}s before using \`${interaction.commandName}\` again.`,
                flags: 64,
            }).catch(() => null);
            return;
        }

        try {
            await command.execute(interaction as ChatInputCommandInteraction);
            client.cooldowns.set(cooldownKey, now + cooldownDuration);
        } catch (error) {
            console.error(`Command error (${interaction.commandName}):`, error);

            const content = `Error: \`${error instanceof Error ? error.message : 'Unknown error'}\``;

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content,
                    flags: 64,
                }).catch(() => null);
            } else {
                await interaction.reply({
                    content,
                    flags: 64,
                }).catch(() => null);
            }
        }
    },
} as Event;

/**
 * Shared ToS + blacklist wall for every interaction type. Returns true when
 * blocked (already replied). One cached read covers acceptance + status.
 */
async function isBlocked(
    interaction: Pick<Interaction, 'user' | 'client'> & {
        reply: (options: Record<string, unknown>) => Promise<unknown>;
    },
): Promise<boolean> {
    const gate = await Users.getGateData(interaction.user.id);

    if (!gate.accepted) {
        await interaction.reply({ ...createTosEmbed(), flags: 64 }).catch(() => null);
        return true;
    }

    if (gate.blacklisted) {
        await interaction
            .reply({
                ...buildBlacklistResponse(gate.reason ?? 'Multiple policy violations', interaction.client),
                flags: 64,
            })
            .catch(() => null);
        return true;
    }
    return false;
}