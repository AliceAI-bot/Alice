import { createClient } from 'redis';
import { loadEnv } from '../config/env.js';

const REDIS_BOOT_TIMEOUT_MS = 30_000;

const redisClient = createClient({
    username: 'default',
    password: loadEnv('redis_pass'),
    socket: {
        host: loadEnv('redis_host'),
        port: Number(loadEnv('redis_port'))
    }
});

redisClient.on('error', (error) => {
    console.error('Redis Client Error:', error);
});
redisClient.on('connect', () => {
    console.log('Redis Client Connected');
});
redisClient.on('reconnecting', () => {
    console.warn('[redis] connection lost — reconnecting...');
});

// First connect is boot-critical and must never hang silently: if Redis
// isn't reachable within the budget we exit(1) so hybrid-sharding respawns us.
const startedAt = Date.now();
const connected = redisClient.connect();

await Promise.race([
    connected,
    new Promise<never>((_, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Redis did not connect within ${REDIS_BOOT_TIMEOUT_MS}ms`)),
            REDIS_BOOT_TIMEOUT_MS,
        );
        timer.unref();
    }),
]).catch((error) => {
    console.error('[boot] Redis unreachable:', error instanceof Error ? error.message : error);
    process.exit(1);
});

console.log(`[boot] redis ready in ${Date.now() - startedAt}ms`);

export default redisClient;
