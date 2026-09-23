import {
    Client,
    Collection,
    GatewayIntentBits,
    Options,
    Partials,
    type ClientOptions,
} from "discord.js";
import {
    ClusterClient,
    ClusterManager,
    getInfo,
    ReClusterManager,
    HeartbeatManager,
} from "discord-hybrid-sharding";
import retry from "async-retry";
import { initTopGG, poststats } from "../integrations/TopGG.js";

export interface CustomClientOptions extends ClientOptions {
    shards?: number[];
    shardCount?: number;
}

export interface ManagerOptions {
    token: string;
    mainFile: string;
    shardsPerClusters?: number;
    topGGToken?: string | null;
}

export class CustomClient extends Client {
    slashCommands: Collection<string, unknown>;
    cooldowns: Collection<string, number>;
    cluster: ClusterClient<this> | null;

    constructor(options: CustomClientOptions) {
        super(options);
        this.slashCommands = new Collection();
        this.cooldowns = new Collection();
        this.cluster = null;

        setInterval(() => {
            const now = Date.now();
            for (const [key, expiry] of this.cooldowns) {
                if (expiry <= now) this.cooldowns.delete(key);
            }
        }, 60 * 1000).unref();
    }
} 

export async function createClient(): Promise<CustomClient> {
    const info = getInfo();

    return new CustomClient({
        shards: info.SHARD_LIST,
        shardCount: info.TOTAL_SHARDS,
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Message, Partials.Channel],
        makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            // Alice keeps conversation history in Redis, never reads the
            // Discord message cache — keep it tiny.
            MessageManager: 50,
            // Never read by this codebase; thread member caches in particular
            // grow with every member of every joined thread otherwise.
            // (Invites aren't cacheable in discord.js at all.)
            ThreadMemberManager: 0,
            ReactionManager: 0,
            GuildBanManager: 0,
        }),
        sweepers: {
            messages: { interval: 600, lifetime: 600 },
            users: {
                interval: 3600,
                filter: () => (user) => user.id !== user.client.user.id,
            },
            guildMembers: {
                interval: 3600,
                filter: () => (member) => member.id !== member.client.user.id,
            },
            threads: { interval: 1800, lifetime: 3600 },
        },
    });
}

export async function loginClient(client: CustomClient, token: string): Promise<void> {
    if (!token) throw new Error("No token provided");

    try {
        await retry(() => client.login(token), {
            retries: 3,
            minTimeout: 1000,
            onRetry: (error: Error, attempt: number) => {
                console.error(
                    `Shard ${client.cluster?.id ?? "unknown"} login attempt ${attempt} failed:`,
                    error.message
                );
            },
        });
        console.log(`Cluster ${client.cluster?.id} logged in successfully`);
    } catch (error) {
        console.error("Login failed after repeated attempts:", error);
        process.exit(1);
    }
}

// Idempotent set — add/delete can't drift the way a ++/-- counter does
// across recluster/exit races.
const readyClusterIds = new Set<number>();

export async function startManager(options: ManagerOptions): Promise<void> {
    const {
        token,
        mainFile,
        shardsPerClusters = 4,
        topGGToken = null,
    } = options;

    const manager = new ClusterManager(mainFile, {
        totalShards: "auto",
        shardsPerClusters,
        mode: "process",
        token,
    });

    manager.extend(new ReClusterManager());
    // 6s death tolerance false-positives under GC/loop lag — 50s is plenty.
    manager.extend(new HeartbeatManager({ interval: 10000, maxMissedHeartbeats: 5 }));

    // Single init, in the MANAGER process — scheduleStats/poststats run here.
    // (Worker-side init would only touch worker memory, where the SDK is unused.)
    if (topGGToken) {
        try {
            initTopGG(topGGToken);
        } catch (error) {
            console.error("Top.gg init failed — stats posting disabled:", error instanceof Error ? error.message : error);
        }
    }

    manager.on("clusterCreate", (cluster) => {
        console.log(`Cluster ${cluster.id} spawned`);

        cluster.on("ready", async () => {
            readyClusterIds.add(cluster.id);
            console.log(`Cluster ${cluster.id} ready (${readyClusterIds.size}/${manager.totalClusters})`);
            if (readyClusterIds.size === manager.totalClusters) {
                await updatePresence(manager, topGGToken);
                if (topGGToken) scheduleStats(manager);
            }
        });

        cluster.on("message", async (msg: any) => {
            if (msg._type === "recluster") {
                await recluster(manager, msg.content as string);
                await msg.reply({ content: "Recluster initiated" });
            }
        });

        cluster.on("error", (error) => {
            console.error(`Cluster ${cluster.id} error:`, error);
        });

        cluster.on("exit", (code, signal) => {
            readyClusterIds.delete(cluster.id);
            console.warn(`Cluster ${cluster.id} exited with code ${code} (signal: ${signal})`);
        });
    });

    process.on("SIGTERM", async () => {
        console.log("Shutting down gracefully...");
        await manager.broadcastEval((c) => c.destroy());
        process.exit(0);
    });

    process.on("unhandledRejection", (error) => {
        console.error("Unhandled rejection:", error);
    });

    try {
        // 7s+ between spawns avoids the /gateway/bot global rate limit warning.
        await manager.spawn({ amount: "auto", delay: 7500, timeout: 600000 });
    } catch (error) {
        console.error("Fatal error during startup:", error);
        process.exit(1);
    }
}

async function recluster(manager: ClusterManager, mode: string) {
    if (!manager.recluster) {
        console.error("ReClusterManager not initialized");
        return;
    }
    console.log(`Initiating recluster with mode: ${mode}`);
    // @ts-expect-error discord-hybrid-sharding types are incomplete
    await manager.recluster.start({ restartMode: mode });
}

async function broadcastTotals(manager: ClusterManager): Promise<{ guilds: number; users: number }> {
    const results = await manager.broadcastEval((client) => ({
        guilds: client.guilds.cache.size,
        users: client.guilds.cache.reduce((a, g) => a + g.memberCount, 0),
    }));

    return {
        guilds: results.reduce((a, b) => a + b.guilds, 0),
        users: results.reduce((a, b) => a + b.users, 0),
    };
}

function scheduleStats(manager: ClusterManager): void {
    // Top.gg is initialized once in bot/index.ts — never re-init here.

    const post = async () => {
        try {
            const totals = await broadcastTotals(manager);
            await poststats(totals.guilds, manager.totalShards);
        } catch (error) {
            console.error("Top.gg stats update failed:", error);
        }
    };

    void post();
    setInterval(post, 30 * 60 * 1000).unref();
}

async function updatePresence(manager: ClusterManager, topGGToken: string | null) {
    try {
        const { guilds: totalGuilds, users: totalUsers } = await broadcastTotals(manager);

        if (topGGToken) {
            console.log(`Stats: ${totalGuilds} guilds, ${manager.totalShards} shards`);
        }

        await manager.broadcastEval(
            (client, { users }) => {
                if (!client.user) return;
                client.user.setPresence({
                    activities: [{
                        name: `with ${users} souls 🌙`,
                        type: 4,
                    }],
                    status: "online",
                });
            },
            { context: { users: totalUsers } }
        );
        startPresenceRotation(manager);
    } catch (error) {
        console.error("Presence update failed:", error);
    }
}

function presenceForNow(): { name: string; status: "online" | "idle" } {
    let hour = new Date().getHours();
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric',
            hour12: false,
            timeZone: 'Asia/Tokyo',
        }).formatToParts(new Date());
        const h = parts.find((p) => p.type === 'hour')?.value;
        if (h !== undefined) hour = Number.parseInt(h, 10) % 24;
    } catch {
        // fall back to local hour
    }
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
    if (hour >= 2 && hour < 5) return { name: pick(['insomnia club 🌙', 'up too late lol', 'zzz... maybe']), status: 'idle' };
    if (hour >= 5 && hour < 11) return { name: pick(['morninggg ☀️', 'coffee + luna 🐈‍⬛', 'touching grass early']), status: 'online' };
    if (hour >= 11 && hour < 17) return { name: pick(['touching grass 🌱', 'with Luna 🐈‍⬛', 'ur local tokyo girl']), status: 'online' };
    if (hour >= 17 && hour < 22) return { name: pick(['golden hour 🌆', 'with Luna 🐈‍⬛', 'yapping hour']), status: 'online' };
    return { name: pick(['late-night convos 🌙', 'overthinking lol', 'up w luna 🐈‍⬛']), status: 'online' };
}

let presenceTimer: NodeJS.Timeout | null = null;
let presenceManager: ClusterManager | null = null;

function startPresenceRotation(manager: ClusterManager): void {
    // Always track the latest manager — a reclustered fleet must not rotate
    // presence through a stale handle.
    presenceManager = manager;
    if (presenceTimer) return;
    const rotate = async () => {
        if (!presenceManager) return;
        try {
            const { name, status } = presenceForNow();
            await presenceManager.broadcastEval(
                (client, ctx) => {
                    if (!client.user) return;
                    client.user.setPresence({
                        activities: [{ name: (ctx as { name: string }).name, type: 4 }],
                        status: (ctx as { status: 'online' | 'idle' }).status,
                    });
                },
                { context: { name, status } },
            );
        } catch (error) {
            console.error('Presence rotation failed:', error);
        }
    };
    // First rotation after 20m so the stats presence gets some screen time, then every 45m.
    presenceTimer = setInterval(() => void rotate(), 45 * 60 * 1000);
    presenceTimer.unref?.();
    setTimeout(() => void rotate(), 20 * 60 * 1000).unref?.();
}