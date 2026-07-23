export {};

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS_BUCKET: R2Bucket;
    }
  }
}
