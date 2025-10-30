import { z } from "zod";
import { createAgentApp } from "@lucid-dreams/agent-kit";
import { Account, Contract, RpcProvider } from "starknet";
import { config, validateConfig, logConfig } from "./config";

// PoolInitialized event selector
const POOL_INITIALIZED_EVENT_SELECTOR = "0x25ccf80ee62b2ca9b97c76ccea317c7f450fd6efb6ed6ea56da21d7bb9da5f1";

// Validate configuration on startup
validateConfig();
logConfig();

// Configure agent options for x402 payments and metadata
const agentOptions = {
  // Payment configuration
  payments: {
    // Default price for entrypoints (in wei/base units)
    defaultPrice: process.env.DEFAULT_PRICE || "1000",
    // Address to receive payments (from environment) - null if not provided
    payTo: process.env.PAY_TO || null,
  },

  // Network configuration
  network: {
    // Payment network from environment
    paymentNetwork: process.env.NETWORK || "base-sepolia",
    // RPC URL for trust interactions
    rpcUrl: process.env.RPC_URL,
    // Auto-register identity at startup
    registerIdentity: process.env.REGISTER_IDENTITY === "true",
  },

  // Facilitator configuration for x402
  facilitator: {
    // Facilitator API URL from environment
    url: process.env.FACILITATOR_URL || "https://facilitator.daydreams.systems",
  },

  // Trust metadata (optional)
  trust: {
    // Trust score or metadata about this agent
    score: 100,
    description: "Reliable Ekubo pool monitoring service with real-time event detection",
    tags: ["defi", "ekubo", "starknet", "pools", "monitoring"],
  },
};

const { app, addEntrypoint } = createAgentApp(
  {
    name: "ekubo-market-watcher",
    version: "0.1.0",
    description: "Discover new pools on Ekubo on Starknet",
  },
  agentOptions
);

console.log(`📝 Agent app created, adding entrypoints...`);

// PoolInitialized event interface based on actual Ekubo Core contract
interface PoolInitializedEvent {
  pool_key: {
    token0: string;
    token1: string;
    fee: number;
    tick_spacing: number;
    extension: string;
  };
  initial_tick: number;
  sqrt_ratio: string;
  block_number: number;
  transaction_hash: string;
  timestamp: number;
}

// Cache for storing recent pools
const poolCache = new Map<string, PoolInitializedEvent>();
const lastCacheUpdate = new Map<string, number>();

// RPC Provider setup
function getRpcProvider(network: string = "mainnet"): RpcProvider {
  const rpcUrl = network === "testnet"
    ? config.starknet.testnetRpcUrl
    : config.starknet.mainnetRpcUrl;

  return new RpcProvider({ nodeUrl: rpcUrl });
}

// Fetch PoolInitialized events from the blockchain
async function fetchPoolInitializedEvents(
  fromBlock: number,
  toBlock: number,
  network: string = "mainnet"
): Promise<PoolInitializedEvent[]> {
  const provider = getRpcProvider(network);
  const contractAddress = config.ekubo.coreAddresses[network as keyof typeof config.ekubo.coreAddresses];

  try {
    // Get event logs
    const eventLogs = await provider.getEvents({
      address: contractAddress,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[POOL_INITIALIZED_EVENT_SELECTOR]], // Event selector constant
      chunk_size: 1000
    });

    const pools: PoolInitializedEvent[] = [];

    for (const event of eventLogs.events) {
      const eventData = extractPoolEventData(event);
      if (eventData) {
        pools.push(eventData);
      }
    }

    if (config.logging.level === "debug") {
      console.debug(`Found ${pools.length} PoolInitialized events from block ${fromBlock} to ${toBlock} on ${network}`);
    }

    return pools;
  } catch (error) {
    console.error("Error fetching PoolInitialized events:", error);
    return [];
  }
}

// Extract pool data from PoolInitialized event based on actual Ekubo Core structure
function extractPoolEventData(event: any): PoolInitializedEvent | null {
  try {
    // PoolInitialized event contains:
    // - pool_key: [token0, token1, fee, tick_spacing, extension]
    // - initial_tick: i129
    // - sqrt_ratio: u256

    const data = event.data || [];
    if (data.length < 7) {
      console.warn("Insufficient event data:", data);
      return null;
    }

    return {
      pool_key: {
        token0: data[0] || "0x",
        token1: data[1] || "0x",
        fee: Number(data[2] || "0"),
        tick_spacing: Number(data[3] || "0"),
        extension: data[4] || "0x",
      },
      initial_tick: Number(data[5] || "0"),
      sqrt_ratio: data[6] || "0",
      block_number: Number(event.block_number || 0),
      transaction_hash: event.transaction_hash || "",
      timestamp: Date.now() // Placeholder - should get from block timestamp
    };
  } catch (error) {
    console.error("Error extracting PoolInitialized event data:", error);
    return null;
  }
}

// Get latest pools within specified time window
async function getLatestPools(minutes: number, network: string = "mainnet"): Promise<PoolInitializedEvent[]> {
  // Validate input
  if (minutes < 1 || minutes > config.network.maxLookbackMinutes) {
    throw new Error(`Minutes must be between 1 and ${config.network.maxLookbackMinutes}`);
  }

  const provider = getRpcProvider(network);
  const currentBlock = await provider.getBlockNumber();
  const lookbackBlocks = Math.ceil(minutes * config.network.blocksPerMinute);
  const fromBlock = Math.max(0, currentBlock - lookbackBlocks);

  // Check cache first
  const cacheKey = `${network}-${fromBlock}-${currentBlock}`;
  const lastUpdate = lastCacheUpdate.get(cacheKey) || 0;
  const now = Date.now();

  if (poolCache.has(cacheKey) && (now - lastUpdate) < config.cache.ttlMs) {
    if (config.logging.level === "debug") {
      console.debug(`Using cached pools for ${network} (${poolCache.size} pools)`);
    }
    return Array.from(poolCache.values());
  }

  // Fetch fresh data
  const pools = await fetchPoolInitializedEvents(fromBlock, currentBlock, network);

  // Update cache
  poolCache.clear();
  lastCacheUpdate.clear();

  pools.forEach(pool => {
    poolCache.set(pool.transaction_hash, pool);
  });
  lastCacheUpdate.set(cacheKey, now);

  if (config.logging.level === "info") {
    console.log(`Updated pool cache for ${network}: ${pools.length} pools from last ${minutes} minutes`);
  }

  return pools;
}

console.log(`➕ Adding entrypoint: list-latest-pools`);
addEntrypoint({
  key: "list-latest-pools",
  description: "Returns a list of new pools created in the given timeframe.",
  input: z.object({
    minutes: z.number().min(1).max(1440).default(60).describe("Time window in minutes (1-1440)"),
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Starknet network"),
  }),
  price: "2000", // 2x default price for premium real-time data

  handler: async ({ input }) => {
    console.log(`🎯 [list-latest-pools] Called with input:`, input);
    const pools = await getLatestPools(input.minutes, input.network);

    return {
      output: {
        pools: pools.map(pool => ({
          pool_key: {
            token0: pool.pool_key.token0,
            token1: pool.pool_key.token1,
            fee: pool.pool_key.fee,
            tick_spacing: pool.pool_key.tick_spacing,
            extension: pool.pool_key.extension,
          },
          initial_tick: pool.initial_tick,
          sqrt_ratio: pool.sqrt_ratio,
          created_at: {
            block_number: pool.block_number,
            transaction_hash: pool.transaction_hash,
            timestamp: pool.timestamp
          }
        })),
        count: pools.length,
        timeframe: {
          minutes: input.minutes,
          network: input.network
        }
      },
    };
  },
});

// Additional entrypoint for getting pools by time window in hours
console.log(`➕ Adding entrypoint: list-pools-by-hours`);
addEntrypoint({
  key: "list-pools-by-hours",
  description: "Returns a list of new pools created in the specified number of hours.",
  input: z.object({
    hours: z.number().min(0.1).max(24).default(1).describe("Time window in hours (0.1-24)"),
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Starknet network"),
  }),
  price: "3000", // 3x default price for longer time windows

  handler: async ({ input }) => {
    console.log(`🎯 [list-pools-by-hours] Called with input:`, input);
    const minutes = Math.ceil(input.hours * 60);
    const pools = await getLatestPools(minutes, input.network);

    return {
      output: {
        pools: pools.map(pool => ({
          pool_key: {
            token0: pool.pool_key.token0,
            token1: pool.pool_key.token1,
            fee: pool.pool_key.fee,
            tick_spacing: pool.pool_key.tick_spacing,
            extension: pool.pool_key.extension,
          },
          initial_tick: pool.initial_tick,
          sqrt_ratio: pool.sqrt_ratio,
          created_at: {
            block_number: pool.block_number,
            transaction_hash: pool.transaction_hash,
            timestamp: pool.timestamp
          }
        })),
        count: pools.length,
        timeframe: {
          hours: input.hours,
          minutes: minutes,
          network: input.network
        }
      },
    };
  },
});

console.log(`✅ All entrypoints added successfully!`);

export { app };
