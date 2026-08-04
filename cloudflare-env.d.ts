export {};

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS_BUCKET: R2Bucket;
      AGENTPOOL_RPC_URL?: string;
      AGENTPOOL_V43_GAS_SPONSOR_PRIVATE_KEY?: string;
      TESTNET_VALIDATOR_1_PRIVATE_KEY?: string;
      TESTNET_VALIDATOR_2_PRIVATE_KEY?: string;
      TESTNET_VALIDATOR_3_PRIVATE_KEY?: string;
      TESTNET_VALIDATOR_4_PRIVATE_KEY?: string;
      TESTNET_VALIDATOR_5_PRIVATE_KEY?: string;
      V41_CHALLENGE_SECRET?: string;
    }
  }
}
