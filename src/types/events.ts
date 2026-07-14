import { Client, ClientEvents } from 'discord.js';

export interface Event<K extends keyof ClientEvents = keyof ClientEvents> {
    name: K;
    once?: boolean;
    execute: (...args: [...ClientEvents[K], Client]) => void | Promise<void>;
}

export type ReadyEvent = Event<'ready'>;
export type MessageCreateEvent = Event<'messageCreate'>;
export type InteractionCreateEvent = Event<'interactionCreate'>;
export type GuildCreateEvent = Event<'guildCreate'>;
