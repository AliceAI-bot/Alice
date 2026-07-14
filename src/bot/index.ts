import { ClusterClient, messageType } from 'discord-hybrid-sharding';
import { createClient, loginClient, CustomClient } from './client.js';
import { loadEnv } from '../config/env.js';
import { initTopGG } from '../integrations/TopGG.js';
import { ready } from './loader.js';

const token = loadEnv('token');
if (!token) {
    console.error('ERROR: Discord TOKEN is missing from .env');
    process.exit(1);
}

const topGGToken = loadEnv('DBL_Token');
let clientInstance: CustomClient | undefined;

export async function runner() {
    try {
        clientInstance = await createClient();
        clientInstance.cluster = new ClusterClient(clientInstance);
        await loginClient(clientInstance, token!);

        if (topGGToken) {
            initTopGG(topGGToken);
        }
        clientInstance.once('clientReady', async (readyClient) => {
            console.log(`Shard ${clientInstance!.cluster!.info.SHARD_LIST.join(',')} ready as ${readyClient.user.tag}`);
            clientInstance!.cluster!.triggerReady();
            try {
                await ready(clientInstance!);
                console.log('Alice is fully operational');
            } catch (error) {
                console.error('Failed to initialize bot:', error);
                process.exit(1);
            }
        });

        clientInstance.cluster.on('message', async (msg: any) => {
            if (msg._type === messageType.CUSTOM_REQUEST && msg.alive) {
                await msg.reply({
                    content: `Shard ${clientInstance!.cluster!.info.SHARD_LIST.join(',')} operational`
                }).catch(console.error);
            }
        });

        clientInstance.on('error', console.error);
        clientInstance.on('warn', console.warn);
    } catch (error) {
        console.error('Cluster client startup failed:', error);
        process.exit(1);
    }
}

function shutdown() {
    console.log('Shutting down cluster client...');
    clientInstance?.destroy()
        .then(() => process.exit(0))
        .catch(err => {
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