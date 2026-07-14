import { loadEnv } from './config/env.js';
import { startManager } from './bot/client.js';

const token = loadEnv('token');
if (!token) {
    console.error('ERROR: Discord TOKEN is missing from .env');
    process.exit(1);
}

const topGGToken = loadEnv('DBL_Token') || null;

startManager({
    token,
    mainFile: './dist/src/bot/index.js',
    shardsPerClusters: 5,
    topGGToken,
});