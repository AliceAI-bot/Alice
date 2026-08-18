import { createClient } from 'redis';
import { loadEnv } from '../config/env.js';

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
await redisClient.connect();

export default redisClient;