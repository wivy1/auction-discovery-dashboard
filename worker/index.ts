/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  STORAGE: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname.startsWith("/stored-images/")
    ) {
      let key = "";
      try {
        key = decodeURIComponent(url.pathname.slice("/stored-images/".length));
      } catch {
        return new Response("Invalid image key", { status: 400 });
      }
      const segments = key.split("/");
      if (
        !key.startsWith("images/") ||
        segments.some((segment) => !segment || segment === "." || segment === "..")
      ) {
        return new Response("Invalid image key", { status: 400 });
      }

      const object = request.method === "HEAD"
        ? await env.STORAGE.head(key)
        : await env.STORAGE.get(key);
      if (!object) {
        return new Response("Image not found", { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=86400, immutable");
      headers.set("x-content-type-options", "nosniff");
      if (request.headers.get("if-none-match") === object.httpEtag) {
        return new Response(null, { status: 304, headers });
      }
      if (request.method === "HEAD") {
        return new Response(null, { headers });
      }
      return new Response((object as R2ObjectBody).body, { headers });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
