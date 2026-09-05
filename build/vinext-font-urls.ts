import { resolve } from "node:path";
import { normalizePath, type Plugin } from "vite";

export function rewriteVinextFontUrls(code: string, cacheDirectory: string, assetsDirectory: string): string {
  const cachePrefix = `${cacheDirectory.replaceAll("\\", "/")}/`;
  const servedPrefix = `/${assetsDirectory || "assets"}/_vinext_fonts/`;
  return code.replace(/(_selfHostedCSS:\s*)("(?:[^"\\]|\\.)*")/g, (match, property, value) => {
    const css: string = JSON.parse(value);
    if (!css.includes(cachePrefix)) return match;
    return property + JSON.stringify(css.split(cachePrefix).join(servedPrefix));
  });
}

// vinext 0.0.50 compares Windows backslashes to forward-slash cached CSS.
// Repair only its generated font CSS; its own middleware/build serves the bytes.
export function vinextFontUrls(): Plugin {
  let layoutId = "";
  let cacheDirectory = "";
  return {
    name: "auction-discovery:vinext-font-urls",
    enforce: "pre",
    configResolved(config) {
      layoutId = normalizePath(resolve(config.root, "app/layout.tsx"));
      cacheDirectory = resolve(config.root, ".vinext/fonts");
    },
    transform(code, id) {
      if (normalizePath(id.split("?")[0]!) !== layoutId || !code.includes("_selfHostedCSS:")) return null;
      const rewritten = rewriteVinextFontUrls(code, cacheDirectory, this.environment.config.build.assetsDir);
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}
