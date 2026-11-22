import { ClusterClient, IPCMessage, messageType } from 'discord-hybrid-sharding';
import { createClient, loginClient, CustomClient } from './client.js';
import { loadEnv } from '../config/env.js';
import { ready } from './loader.js';
import { initDB } from '../db/database.js';

const token = loadEnv('token');
if (!token) {
    console.error('ERROR: Discord TOKEN is missing from .env');
    process.exit(1);
}

let clientInstance: CustomClient | undefined;

const BOOT_TIMEOUT_MS = 30_000;

function withBootTimeout<T>(what: string, task: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${what} not ready within ${BOOT_TIMEOUT_MS}ms`)),
            BOOT_TIMEOUT_MS,
        );
        timer.unref();
        task.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

async function runner(): Promise<void> {
    const startedAt = Date.now();
    const dbReady = initDB();
    dbReady.catch(() => {});

    try {
        const client = await createClient();
        clientInstance = client;
        const cluster = new ClusterClient(client);
        client.cluster = cluster;

        client.once('clientReady', async (readyClient) => {
            console.log(`Shard ${cluster.info.SHARD_LIST.join(',')} ready as ${readyClient.user.tag}`);
            console.log(`[boot] gateway ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
            cluster.triggerReady();
            try {
                await withBootTimeout('Couchbase', dbReady);
                console.log(`[boot] couchbase ready in ${Date.now() - startedAt}ms`);
                await ready(client);
                console.log(`[boot] Alice fully operational in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
            } catch (error) {
                console.error(
                    '[boot] Startup failed/timed out — exiting for respawn:',
                    error instanceof Error ? error.message : error,
                );
                process.exit(1);
            }
        });

        await loginClient(client, token);

        cluster.on('message', async (msg) => {
            if (msg instanceof IPCMessage && msg._type === messageType.CUSTOM_REQUEST && msg.alive) {
                await msg.reply({
                    content: `Shard ${cluster.info.SHARD_LIST.join(',')} operational`,
                }).catch(console.error);
            }
        });

        client.on('error', console.error);
        client.on('warn', console.warn);
    } catch (error) {
        console.error('Cluster client startup failed:', error);
        process.exit(1);
    }
}

function shutdown(): void {
    console.log('Shutting down cluster client...');
    clientInstance?.destroy()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('Shutdown error:', err);
            process.exit(1);
        });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    shutdown();
});

runner();
