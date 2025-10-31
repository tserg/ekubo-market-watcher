import { z } from "zod";
import {
  createAgentApp,
  AgentKitConfig,
} from "@lucid-dreams/agent-kit";
import { Account, Contract, RpcProvider } from "starknet";
import { config, validateConfig, logConfig } from "./config";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * Ekubo Market Watcher - Real-time pool monitoring on Starknet.
 * Monitors PoolInitialized events from the Ekubo Core contract.
 *
 * Required environment variables:
 *   - PRIVATE_KEY      (used for x402 payments)
 */

// Validate configuration on startup
validateConfig();
logConfig();

// Agent configuration using config from src/config.ts
const configOverrides: AgentKitConfig = {
  payments: config.agent.payments,
  network: config.agent.paymentNetwork,
  facilitator: config.agent.facilitator,
  trust: config.agent.trust,
};


const { app, addEntrypoint } = createAgentApp(
  {
    name: "ekubo-market-watcher",
    version: "0.1.0",
    description: "Real-time monitoring of new pools created on Ekubo.",
  },
  {
    config: configOverrides,
  }
);


console.log(`📝 Agent app created, adding pool monitoring entrypoints...`);

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
      keys: [[config.ekubo.eventSelector]], // Event selector from config (nested array)
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
      timestamp: Date.now()
    };
  } catch (error) {
    console.error("Error extracting PoolInitialized event data:", error);
    return null;
  }
}

// Get latest pools within specified time window
async function getLatestPools(minutes: number, network: string = "mainnet"): Promise<PoolInitializedEvent[]> {
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
    minutes: z.string().transform(Number).refine(n => !isNaN(n) && n >= 1 && n <= 1440, {
      message: "Minutes must be a number between 1 and 1440"
    }).default("60").describe("Time window in minutes (1-1440)"),
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Starknet network"),
  }),
  price: "0.02",

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
          block_number: pool.block_number,
          transaction_hash: pool.transaction_hash,
          timestamp: pool.timestamp
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

console.log(`➕ Adding entrypoint: list-pools-by-hours`);
addEntrypoint({
  key: "list-pools-by-hours",
  description: "Returns a list of new pools created in the specified number of hours.",
  input: z.object({
    hours: z.string().transform(Number).refine(n => !isNaN(n) && n >= 0.1 && n <= 24, {
      message: "Hours must be a number between 0.1 and 24"
    }).default("1").describe("Time window in hours (0.1-24)"),
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Starknet network (mainnet/sepolia)"),
  }),
  price: "0.03",

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
