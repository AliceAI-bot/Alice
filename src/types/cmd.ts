import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    SlashCommandSubcommandsOnlyBuilder,
    ContextMenuCommandBuilder,
    PermissionResolvable,
    AutocompleteInteraction,
} from 'discord.js';

export interface Command {
    data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | ContextMenuCommandBuilder;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
    global?: boolean;
    cooldown?: number;

    permissions?: PermissionResolvable[];
    autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export interface LoadedCommand extends Command {
    filePath: string;
    category: string;
}
