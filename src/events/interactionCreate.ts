import { Events, Interaction, ChatInputCommandInteraction } from 'discord.js'; import { CustomClient } from '../bot/client.js'; import type { Event, Command } from '../types/index.js';
// ik ik the line above is very sigma
//
export default {
    name: Events.InteractionCreate,
    async execute(interaction: Interaction, client: CustomClient): Promise<void> {
        // Autocomplete
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

        // Chat commands
        if (!interaction.isChatInputCommand()) return;

        const command = client.slashCommands.get(interaction.commandName) as Command | undefined;
        if (!command) {
            console.warn(`No command: ${interaction.commandName}`);
            return;
        }

        // Cooldown check
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

        // Execute command
        try {
            await command.execute(interaction as ChatInputCommandInteraction);
            client.cooldowns.set(cooldownKey, now + cooldownDuration);
        } catch (error) {
            console.error(`Command error (${interaction.commandName}):`, error);

            const content = `Error: \`${error instanceof Error ? error.message : 'Unknown error'}\``;

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content,
                    flags: 64, // this is emph message btw, pretty sure yall should know this
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
