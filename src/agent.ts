import { z } from "zod";
import {
  createAgentApp,
  AgentKitConfig,
} from "@lucid-dreams/agent-kit";
import { Account, Contract, RpcProvider, shortString, num } from "starknet";
import { config, validateConfig, logConfig } from "./config";
import { ERC20_ABI } from "./erc20-abi";
import { STARKNET_TOKENS, getTokenSymbol as getStarknetTokenSymbol } from "./starknet-token-addresses";
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
  description?: string;
  token0_symbol?: string;
  token1_symbol?: string;
}

// Cache for storing recent pools
const poolCache = new Map<string, PoolInitializedEvent>();
const lastCacheUpdate = new Map<string, number>();
// Cache for storing block timestamps to avoid repeated RPC calls
const blockTimestampCache = new Map<number, number>();
// Cache for storing token symbols to avoid repeated ERC20 calls
const tokenSymbolCache = new Map<string, string>();

// RPC Provider setup
function getRpcProvider(network: string = "mainnet"): RpcProvider {
  const rpcUrl = network === "testnet"
    ? config.starknet.testnetRpcUrl
    : config.starknet.mainnetRpcUrl;

  return new RpcProvider({ nodeUrl: rpcUrl });
}

// Fetch token symbol with caching
async function getTokenSymbol(tokenAddress: string, network: string = "mainnet"): Promise<string> {
  // Check cache first
  if (tokenSymbolCache.has(tokenAddress)) {
    return tokenSymbolCache.get(tokenAddress)!;
  }

  // First try to get symbol from our comprehensive Starknet token mapping
  // Handle addresses that might be missing the "0x" prefix or have dropped leading zeros
  let normalizedAddress = tokenAddress.toLowerCase();

  // Ensure address starts with 0x
  if (!normalizedAddress.startsWith('0x')) {
    normalizedAddress = '0x' + normalizedAddress;
  }

  // Remove the 0x prefix for length checking and padding
  const hexPart = normalizedAddress.slice(2);

  // Pad to full 32 bytes (64 hex characters) if shorter
  if (hexPart.length < 64) {
    const paddedHex = hexPart.padStart(64, '0');
    normalizedAddress = '0x' + paddedHex;
  }

  const mappedSymbol = getStarknetTokenSymbol(normalizedAddress);

  if (mappedSymbol) {
    // Cache the result
    tokenSymbolCache.set(tokenAddress, mappedSymbol);

    if (config.logging.level === "debug") {
      console.debug(`Found token symbol in mapping: ${tokenAddress} -> ${mappedSymbol}`);
    }

    return mappedSymbol;
  }

  // If not found in mapping, try to fetch from contract dynamically
  try {
    const provider = getRpcProvider(network);

    // Fetch the ABI dynamically from the contract
    const { abi: tokenAbi } = await provider.getClassAt(tokenAddress, "latest");
    if (tokenAbi === undefined) {
      throw new Error('no ABI found for token contract');
    }

    const contract = new Contract(tokenAbi, tokenAddress, provider);

    // Try to call the symbol function directly (common in ERC20 tokens)
    const symbolResponse = await contract.call('symbol', [], { blockIdentifier: 'latest' });

    // Helper function to decode felt to string
    const decodeFeltToString = (felt: bigint): string => {
      try {
        // Use shortString.decodeShortString to decode the felt
        return shortString.decodeShortString(num.toHex(felt));
      } catch (error) {
        if (config.logging.level === "debug") {
          console.debug(`Failed to decode felt ${felt}, using hex fallback:`, error);
        }
        return felt.toString();
      }
    };

    let symbol: string;

    if (symbolResponse && typeof symbolResponse === 'object' && 'data' in symbolResponse) {
      // Handle Cairo 0 array response style (long string format)
      try {
        // First check if data array has meaningful content after filtering zeros
        if (symbolResponse.data && Array.isArray(symbolResponse.data)) {
          const filteredData = symbolResponse.data.filter((felt: bigint) => felt !== 0n);
          if (filteredData.length > 0) {
            // Convert each felt in the data array to string
            const longString = filteredData
              .map((felt: bigint) => decodeFeltToString(felt))
              .join('');
            symbol = longString;
          } else if (symbolResponse.pending_word && symbolResponse.pending_word_len > 0) {
            // Handle pending word when data array is empty
            symbol = decodeFeltToString(symbolResponse.pending_word);
          } else {
            symbol = 'UNKNOWN';
          }
        } else if (symbolResponse.pending_word && symbolResponse.pending_word_len > 0) {
          // Handle pending word when no data array
          symbol = decodeFeltToString(symbolResponse.pending_word);
        } else {
          symbol = 'UNKNOWN';
        }
      } catch (error) {
        if (config.logging.level === "debug") {
          console.debug(`Failed to decode long string:`, error);
        }
        symbol = 'UNKNOWN';
      }
    } else if (typeof symbolResponse === 'bigint') {
      // Direct felt response
      symbol = decodeFeltToString(symbolResponse);
    } else if (Array.isArray(symbolResponse) && symbolResponse.length > 0) {
      // Handle array response (might be a long string split into parts)
      const longString = symbolResponse
        .filter((item: any) => item !== 0n && item !== undefined) // Remove empty values
        .map((item: any) => {
          if (typeof item === 'bigint') {
            return decodeFeltToString(item);
          } else if (typeof item === 'string') {
            return item;
          } else {
            return item?.toString() || '';
          }
        })
        .join('');
      symbol = longString || 'UNKNOWN';
    } else {
      // Fallback to string conversion
      symbol = symbolResponse?.toString() || 'UNKNOWN';
    }

    // Cache the result
    tokenSymbolCache.set(tokenAddress, symbol);

    if (config.logging.level === "debug") {
      console.debug(`Fetched token symbol from contract: ${tokenAddress} -> ${symbol}`);
    }

    return symbol;
  } catch (error) {
    console.warn(`Failed to fetch symbol for token ${tokenAddress}:`, error);
    // Return address as fallback
    const fallback = tokenAddress.slice(0, 6) + "..." + tokenAddress.slice(-4);
    tokenSymbolCache.set(tokenAddress, fallback);
    return fallback;
  }
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
    const uniqueBlockNumbers = [...new Set(eventLogs.events.map(e => e.block_number))];

    // Fetch block timestamps in batch (with caching)
    const blockTimestamps = new Map<number, number>();
    const uncachedBlockNumbers: number[] = [];

    // Check cache first
    for (const blockNumber of uniqueBlockNumbers) {
      if (blockTimestampCache.has(blockNumber)) {
        blockTimestamps.set(blockNumber, blockTimestampCache.get(blockNumber)!);
      } else {
        uncachedBlockNumbers.push(blockNumber);
      }
    }

    // Fetch only uncached block timestamps
    if (uncachedBlockNumbers.length > 0) {
      if (config.logging.level === "debug") {
        console.debug(`Fetching timestamps for ${uncachedBlockNumbers.length} uncached blocks`);
      }

      for (const blockNumber of uncachedBlockNumbers) {
        try {
          const blockInfo = await provider.getBlock(blockNumber);
          if (blockInfo?.timestamp) {
            const timestamp = Number(blockInfo.timestamp);
            blockTimestamps.set(blockNumber, timestamp);
            blockTimestampCache.set(blockNumber, timestamp); // Cache for future use
          }
        } catch (error) {
          if (config.logging.level === "debug") {
            console.debug(`Could not fetch block ${blockNumber} timestamp:`, error);
          }
        }
      }
    }

    for (const event of eventLogs.events) {
      const eventData = await extractPoolEventData(event, provider, network, blockTimestamps.get(event.block_number));
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
async function extractPoolEventData(event: any, provider: RpcProvider, network: string, blockTimestamp?: number): Promise<PoolInitializedEvent | null> {
  try {
    const data = event.data || [];
    if (data.length < 7) {
      console.warn("Insufficient event data:", data);
      return null;
    }

    const token0Address = data[0] || "0x";
    const token1Address = data[1] || "0x";

    // Fetch token symbols in parallel
    const [token0Symbol, token1Symbol] = await Promise.all([
      getTokenSymbol(token0Address, network),
      getTokenSymbol(token1Address, network)
    ]);

    // Create pool description
    const description = `${token0Symbol}-${token1Symbol}`;

    return {
      pool_key: {
        token0: token0Address,
        token1: token1Address,
        fee: Number(data[2] || "0"),
        tick_spacing: Number(data[3] || "0"),
        extension: data[4] || "0x",
      },
      initial_tick: Number(data[5] || "0"),
      sqrt_ratio: data[6] || "0",
      block_number: Number(event.block_number || 0),
      transaction_hash: event.transaction_hash || "",
      timestamp: blockTimestamp || 0,
      description,
      token0_symbol: token0Symbol,
      token1_symbol: token1Symbol
    };
  } catch (error) {
    console.error("Error extracting PoolInitialized event data:", error);
    return null;
  }
}

// Get latest pools within specified time window using chunk-based approach
async function getLatestPools(minutes: number, network: string = "mainnet"): Promise<PoolInitializedEvent[]> {
  if (minutes < 1 || minutes > config.network.maxLookbackMinutes) {
    throw new Error(`Minutes must be between 1 and ${config.network.maxLookbackMinutes}`);
  }

  const provider = getRpcProvider(network);
  const currentBlock = await provider.getBlockNumber();
  const cutoffTimeInSeconds = Math.floor(Date.now() / 1000) - (minutes * 60);
  const chunkSize = config.network.blockChunkSize;

  // Check cache first - use time-based cache key
  const cacheKey = `${network}-${minutes}`;
  const lastUpdate = lastCacheUpdate.get(cacheKey) || 0;
  const now = Date.now();

  if (poolCache.size > 0 && (now - lastUpdate) < config.cache.ttlMs) {
    if (config.logging.level === "debug") {
      console.debug(`Using cached pools for ${network} (${poolCache.size} pools)`);
    }
    // Filter cached pools to match the requested timeframe
    return Array.from(poolCache.values()).filter(pool => pool.timestamp >= cutoffTimeInSeconds);
  }

  // Search backwards in chunks until the block range is older than our time window
  let allPools: PoolInitializedEvent[] = [];
  let fromBlock = Math.max(0, currentBlock - chunkSize);
  let toBlock = currentBlock;

  if (config.logging.level === "info") {
    console.log(`🔍 Starting chunk search for pools in last ${minutes} minutes (cutoff: ${cutoffTimeInSeconds})`);
  }

  while (true) {
    // Get the timestamp of the toBlock to check if this chunk is too old
    try {
      const toBlockInfo = await provider.getBlock(toBlock);
      if (toBlockInfo && toBlockInfo.timestamp < cutoffTimeInSeconds) {
        // This block range is older than our time window, we're done
        if (config.logging.level === "debug") {
          console.debug(`✅ Block ${toBlock} (timestamp: ${toBlockInfo.timestamp}) is older than cutoff (${cutoffTimeInSeconds}), stopping search`);
        }
        break;
      }
    } catch (error) {
      if (config.logging.level === "debug") {
        console.debug(`Could not get block ${toBlock} info, continuing search`);
      }
    }

    const chunkPools = await fetchPoolInitializedEvents(fromBlock, toBlock, network);

    if (config.logging.level === "debug") {
      console.debug(`Chunk: Searching blocks ${fromBlock}-${toBlock}, found ${chunkPools.length} pools`);
    }

    // Add pools from this chunk
    allPools.push(...chunkPools);

    // Move to next chunk
    toBlock = fromBlock - 1;
    fromBlock = Math.max(0, fromBlock - chunkSize);

    // Stop if we've reached the beginning of the blockchain
    if (fromBlock === 0 && toBlock === 0) {
      if (config.logging.level === "debug") {
        console.debug(`🔚 Reached block 0, stopping search`);
      }
      break;
    }
  }

  // Filter all pools by time
  const filteredPools = allPools.filter(pool => pool.timestamp >= cutoffTimeInSeconds);

  if (config.logging.level === "info") {
    console.log(`🔍 Search complete: ${allPools.length} total pools found, ${filteredPools.length} within last ${minutes} minutes`);

    // Debug: Show detailed information about all pools found
    console.log(`📊 Pool details found:`);
    allPools.forEach((pool, i) => {
      const ageHours = (Math.floor(Date.now() / 1000) - pool.timestamp) / 3600;
      const poolDate = pool.timestamp > 0 ? new Date(pool.timestamp * 1000).toISOString() : 'No timestamp';
      console.log(`   ${i+1}. Pool: ${pool.transaction_hash.slice(0, 10)}...`);
      console.log(`      Description: ${pool.description || 'Unknown'}`);
      console.log(`      Token0: ${pool.token0_symbol || pool.pool_key.token0.slice(0, 10)}... (${pool.pool_key.token0.slice(0, 6)}...)`);
      console.log(`      Token1: ${pool.token1_symbol || pool.pool_key.token1.slice(0, 10)}... (${pool.pool_key.token1.slice(0, 6)}...)`);
      console.log(`      Fee: ${pool.pool_key.fee}`);
      console.log(`      Block: ${pool.block_number}`);
      console.log(`      Timestamp: ${pool.timestamp}`);
      console.log(`      Date: ${poolDate}`);
      console.log(`      Age: ${ageHours.toFixed(1)} hours ago`);
      console.log(`      Within 24h: ${pool.timestamp >= cutoffTimeInSeconds}`);
      console.log(`      ------------------------`);
    });
  }

  // Update cache with all pools found (not just filtered ones)
  poolCache.clear();
  lastCacheUpdate.clear();

  allPools.forEach(pool => {
    poolCache.set(pool.transaction_hash, pool);
  });
  lastCacheUpdate.set(cacheKey, now);

  if (config.logging.level === "info") {
    console.log(`Updated pool cache for ${network}: ${allPools.length} total pools, ${filteredPools.length} within last ${minutes} minutes`);
  }

  return filteredPools;
}

console.log(`➕ Adding entrypoint: list-latest-pools`);
addEntrypoint({
  key: "list-latest-pools",
  description: "Returns a list of new pools created in the given timeframe.",
  input: z.object({
    minutes: z.string().min(1).max(config.network.maxLookbackMinutes).default("60").describe(`Time window in minutes (1-${config.network.maxLookbackMinutes})`),
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Starknet network"),
  }),
  output: z.object({
    pools: z.array(z.object({
      pool_key: z.object({
        token0: z.string(),
        token1: z.string(),
        fee: z.number(),
        tick_spacing: z.number(),
        extension: z.string(),
      }),
      initial_tick: z.number(),
      sqrt_ratio: z.string(),
      block_number: z.number(),
      transaction_hash: z.string(),
      timestamp: z.number(),
      description: z.string().optional(),
      token0_symbol: z.string().optional(),
      token1_symbol: z.string().optional(),
    })),
    count: z.number(),
    timeframe: z.object({
      minutes: z.number(),
      network: z.string(),
    }),
  }),
  price: "0.02",

  handler: async ({ input }) => {
    console.log(`🎯 [list-latest-pools] Called with input:`, input);
    const minutes = parseInt(input.minutes, 10);
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
          block_number: pool.block_number,
          transaction_hash: pool.transaction_hash,
          timestamp: pool.timestamp,
          description: pool.description,
          token0_symbol: pool.token0_symbol,
          token1_symbol: pool.token1_symbol
        })),
        count: pools.length,
        timeframe: {
          minutes: minutes,
          network: input.network
        }
      }
    };
  },
});

console.log(`➕ Adding entrypoint: list-pools-by-hours`);
addEntrypoint({
  key: "list-pools-by-hours",
  description: "Returns a list of new pools created in the specified number of hours.",
  input: z.object({
    hours: z.string().min(1).max(24).default("1").describe("Time window in hours (0.1-24)"),
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Starknet network (mainnet/sepolia)"),
  }),
  output: z.object({
    pools: z.array(z.object({
      pool_key: z.object({
        token0: z.string(),
        token1: z.string(),
        fee: z.number(),
        tick_spacing: z.number(),
        extension: z.string(),
      }),
      initial_tick: z.number(),
      sqrt_ratio: z.string(),
      created_at: z.object({
        block_number: z.number(),
        transaction_hash: z.string(),
        timestamp: z.number(),
      }),
    })),
    count: z.number(),
    timeframe: z.object({
      hours: z.number(),
      minutes: z.number(),
      network: z.string(),
    }),
  }),
  price: "0.03",

  handler: async ({ input }) => {
    console.log(`🎯 [list-pools-by-hours] Called with input:`, input);
    const hours = parseFloat(input.hours);
    const minutes = Math.ceil(hours * 60);
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
          },
          description: pool.description,
          token0_symbol: pool.token0_symbol,
          token1_symbol: pool.token1_symbol
        })),
        count: pools.length,
        timeframe: {
          hours: hours,
          minutes: minutes,
          network: input.network
        }
      }
    };
  },
});

console.log(`✅ All entrypoints added successfully!`);

export { app };
