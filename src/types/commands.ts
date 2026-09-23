import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    SlashCommandSubcommandsOnlyBuilder,
    ContextMenuCommandBuilder,
    AutocompleteInteraction,
} from 'discord.js';

export interface Command {
    data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | ContextMenuCommandBuilder;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
    global?: boolean;
    cooldown?: number;

    autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}
