declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    STORAGE: R2Bucket;
    IMAGES: {
      input(stream: ReadableStream): {
        transform(options: Record<string, unknown>): {
          output(options: {
            format: string;
            quality: number;
          }): Promise<{ response(): Response }>;
        };
      };
    };
  }
}
