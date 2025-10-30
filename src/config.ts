import { config as dotenvConfig } from "dotenv";

// Load environment variables
dotenvConfig();

export interface Config {
  starknet: {
    mainnetRpcUrl: string;
    testnetRpcUrl: string;
  };
  ekubo: {
    coreAddresses: {
      mainnet: string;
      testnet: string;
    };
    eventSelector: string;
  };
  cache: {
    ttlMs: number;
    maxCacheSize: number;
  };
  network: {
    blocksPerMinute: number;
    maxLookbackMinutes: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
}

export const config: Config = {
  starknet: {
    mainnetRpcUrl: process.env.STARKNET_RPC_URL || "https://starknet-mainnet.infura.io/v3/YOUR_INFURA_KEY",
    testnetRpcUrl: process.env.STARKNET_TESTNET_RPC_URL || "https://starknet-goerli.infura.io/v3/YOUR_INFURA_KEY",
  },
  ekubo: {
    // Actual Ekubo Core contract addresses
    coreAddresses: {
      mainnet: process.env.EKUBO_CORE_MAINNET || "0x00000005dd3D2F4429AF886cD1a3b08289DBcEa99A294197E9eB43b0e0325b4b",
      testnet: process.env.EKUBO_CORE_TESTNET || "0x0444a09d96389aa7148f1aada508e30b71299ffe650d9c97fdaae38cb9a23384",
    },
    eventSelector: process.env.POOL_INITIALIZED_EVENT_SELECTOR || "0x25ccf80ee62b2ca9b97c76ccea317c7f450fd6efb6ed6ea56da21d7bb9da5f1",
  },
  cache: {
    ttlMs: parseInt(process.env.CACHE_TTL_MS || "60000"), // 60 seconds
    maxCacheSize: parseInt(process.env.MAX_POOL_CACHE_SIZE || "1000"),
  },
  network: {
    blocksPerMinute: parseInt(process.env.BLOCKS_PER_MINUTE || "60"), // Approximate
    maxLookbackMinutes: parseInt(process.env.MAX_LOOKBACK_MINUTES || "1440"), // 24 hours
  },
  logging: {
    level: (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") || "info",
  },
};

// Validation function to ensure required configuration is present
export function validateConfig(): void {
  const errors: string[] = [];

  // Check Starknet RPC URLs
  if (config.starknet.mainnetRpcUrl.includes("YOUR_INFURA_KEY") || config.starknet.mainnetRpcUrl === "") {
    errors.push("STARKNET_RPC_URL must be configured with a valid RPC URL");
  }

  // Check Ekubo Core addresses
  if (config.ekubo.coreAddresses.mainnet === "0x..." || config.ekubo.coreAddresses.mainnet === "") {
    errors.push("EKUBO_CORE_MAINNET must be configured with the actual Ekubo Core contract address");
  }

  // Check event selector
  if (!config.ekubo.eventSelector || config.ekubo.eventSelector === "") {
    errors.push("POOL_INITIALIZED_EVENT_SELECTOR must be configured");
  }

  if (errors.length > 0) {
    console.error("Configuration validation failed:");
    errors.forEach(error => console.error(`  - ${error}`));
    console.error("\nPlease check your .env file and ensure all required configuration is set.");
    process.exit(1);
  }
}

// Log configuration (without sensitive data)
export function logConfig(): void {
  console.log("=== Ekubo Market Watcher Configuration ===");
  console.log(`Cache TTL: ${config.cache.ttlMs}ms`);
  console.log(`Max cache size: ${config.cache.maxCacheSize}`);
  console.log(`Blocks per minute: ${config.network.blocksPerMinute}`);
  console.log(`Max lookback: ${config.network.maxLookbackMinutes} minutes`);
  console.log(`Log level: ${config.logging.level}`);
  console.log(`Starknet mainnet RPC configured: ${!config.starknet.mainnetRpcUrl.includes("YOUR_INFURA_KEY")}`);
  console.log(`Ekubo Core mainnet address configured: ${config.ekubo.coreAddresses.mainnet !== "0x..."}`);
  console.log(`PoolInitialized event selector configured: ${!!config.ekubo.eventSelector}`);
  console.log("==========================================");
}