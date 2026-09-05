const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function decodeHtml(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (decimal) return safeCodePoint(Number.parseInt(decimal, 10), entity);
      if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      return NAMED_ENTITIES[named?.toLowerCase() ?? ""] ?? entity;
    },
  );
}

export function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/?(?:article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|section|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t \f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function oneLineText(html: string): string {
  return htmlToText(html).replace(/\s+/g, " ").trim();
}

export function parseTagAttributes(tag: string): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;

  // Skip the element name.
  pattern.exec(tag.replace(/^<\/?/, ""));
  while ((match = pattern.exec(tag.replace(/^<\/?/, "")))) {
    const name = match[1].toLowerCase();
    attributes[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

export function extractAttribute(tag: string, name: string): string | null {
  return parseTagAttributes(tag)[name.toLowerCase()] ?? null;
}

export function extractFirstElementText(
  html: string,
  pattern: RegExp,
): string | null {
  const match = pattern.exec(html);
  return match ? oneLineText(match[1] ?? match[0]) || null : null;
}

export function stableContentHash(value: unknown): string {
  const text = stableSerialize(value);
  const left = fnv1a32(text, 0x811c9dc5);
  const right = fnv1a32(text, 0x9e3779b9);
  return `fnv1a64:${hex32(left)}${hex32(right)}`;
}

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
    .join(",")}}`;
}

export function cleanNullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = decodeHtml(value).replace(/\s+/g, " ").trim();
  if (!clean || /^(?:loading(?:\.\.\.)?|n\/?a|null|undefined)$/i.test(clean)) {
    return null;
  }
  return clean;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
