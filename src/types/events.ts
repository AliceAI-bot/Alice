import { Client, ClientEvents } from 'discord.js';

export interface Event<K extends keyof ClientEvents = keyof ClientEvents> {
    name: K;
    once?: boolean;
    execute: (...args: [...ClientEvents[K], Client]) => void | Promise<void>;
}
