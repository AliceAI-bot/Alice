import {
    Client,
    Collection,
    GatewayIntentBits,
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

export interface MaintenanceState {
    maintenance_mode: boolean;
    maintenance_reason: string | null;
    maintenance_end: Date | null;
}

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
    maintenance: MaintenanceState;

    constructor(options: CustomClientOptions) {
        super(options);
        this.slashCommands = new Collection();
        this.cooldowns = new Collection();
        this.cluster = null;
        this.maintenance = {
            maintenance_mode: false,
            maintenance_reason: null,
            maintenance_end: null,
        };
    }

    get isMaintenance(): boolean {
        if (!this.maintenance.maintenance_mode) return false;
        if (this.maintenance.maintenance_end && new Date() > this.maintenance.maintenance_end) {
            this.maintenance.maintenance_mode = false;
            return false;
        }
        return true;
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
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.DirectMessageReactions,
        ],
        partials: [
            Partials.Message,
            Partials.Channel,
            Partials.Reaction,
            Partials.GuildMember,
            Partials.User,
            Partials.ThreadMember,
        ],
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
        console.error("Failed to login after 5 attempts:", error);
        process.exit(1);
    }
}

let readyClusters = 0;

export async function startManager(options: ManagerOptions): Promise<void> {
    const {
        token,
        mainFile,
        shardsPerClusters = 5,
        topGGToken = null,
    } = options;

    const manager = new ClusterManager(mainFile, {
        totalShards: "auto",
        shardsPerClusters,
        mode: "process",
        token,
    });

    manager.extend(new ReClusterManager());
    manager.extend(new HeartbeatManager({ interval: 2000, maxMissedHeartbeats: 3 }));

    manager.on("clusterCreate", (cluster) => {
        console.log(`Cluster ${cluster.id} spawned`);

        cluster.on("ready", async () => {
            readyClusters++;
            console.log(`Cluster ${cluster.id} ready (${readyClusters}/${manager.totalClusters})`);
            if (readyClusters === manager.totalClusters) {
                await updatePresence(manager, topGGToken);
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
            readyClusters = Math.max(0, readyClusters - 1);
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
        await manager.spawn({ amount: "auto", delay: 2000, timeout: 600000 });
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

async function updatePresence(manager: ClusterManager, topGGToken: string | null) {
    try {
        const results = await manager.broadcastEval((client) => ({
            guilds: client.guilds.cache.size,
            users: client.guilds.cache.reduce((a, g) => a + g.memberCount, 0),
        }));

        const totalGuilds = results.reduce((a, b) => a + b.guilds, 0);
        const totalUsers = results.reduce((a, b) => a + b.users, 0);

        if (topGGToken) {
            console.log(`Stats: ${totalGuilds} guilds, ${manager.totalShards} shards`);
        }

        await manager.broadcastEval(
            (client, { guilds, users }) => {
                if (!client.user) return;
                client.user.setPresence({
                    activities: [{
                        name: `Connected with ${users} souls across ${guilds} realms.`,
                        type: 4,
                    }],
                    status: "dnd",
                });
            },
            { context: { guilds: totalGuilds, users: totalUsers } }
        );
    } catch (error) {
        console.error("Presence update failed:", error);
    }
}

// ballz