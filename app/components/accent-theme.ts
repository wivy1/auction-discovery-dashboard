export const ACCENT_COOKIE_NAME = "auction-discovery-accent";
export const BACKGROUND_COOKIE_NAME = "auction-discovery-background";

export const DEFAULT_ACCENT_COLOR = "#7c3aed";
export const DEFAULT_BACKGROUND_COLOR = "#24133f";

export const accentThemes = [
  { id: "violet", label: "Violet", color: DEFAULT_ACCENT_COLOR },
  { id: "indigo", label: "Indigo", color: "#4f46e5" },
  { id: "blue", label: "Blue", color: "#2563eb" },
  { id: "teal", label: "Teal", color: "#0f766e" },
  { id: "coral", label: "Coral", color: "#e35d6a" },
] as const;

export type AccentTheme = (typeof accentThemes)[number]["id"];

export function isAccentTheme(value: string | null | undefined): value is AccentTheme {
  return accentThemes.some((theme) => theme.id === value);
}

export function normalizeHexColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const candidate = value.startsWith("#") ? value : `#${value}`;
  return /^#[0-9a-f]{6}$/iu.test(candidate) ? candidate.toLowerCase() : fallback;
}

export function resolveAccentColor(value: string | null | undefined): string {
  if (isAccentTheme(value)) {
    return accentThemes.find((theme) => theme.id === value)?.color ?? DEFAULT_ACCENT_COLOR;
  }
  return normalizeHexColor(value, DEFAULT_ACCENT_COLOR);
}

function rgb(color: string): [number, number, number] {
  const normalized = normalizeHexColor(color, DEFAULT_ACCENT_COLOR);
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function relativeLuminance(color: string): number {
  const channels = rgb(color).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(left: string, right: string): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function contrastingText(background: string): "#000000" | "#ffffff" {
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#ffffff")
    ? "#000000"
    : "#ffffff";
}

function mix(color: string, target: "#000000" | "#ffffff", targetWeight: number): string {
  const from = rgb(color);
  const to = target === "#ffffff" ? [255, 255, 255] : [0, 0, 0];
  return `#${from.map((channel, index) =>
    Math.round(channel * (1 - targetWeight) + to[index]! * targetWeight)
      .toString(16)
      .padStart(2, "0")
  ).join("")}`;
}

export function createInterfacePalette(accentValue: string, backgroundValue: string) {
  const accent = normalizeHexColor(accentValue, DEFAULT_ACCENT_COLOR);
  const background = normalizeHexColor(backgroundValue, DEFAULT_BACKGROUND_COLOR);
  const [red, green, blue] = rgb(accent);
  const accentText = contrastingText(accent);
  const chromeText = contrastingText(background);
  return {
    accent,
    accentText,
    accentDark: mix(accent, "#000000", 0.16),
    accentSoft: mix(accent, "#ffffff", 0.9),
    accentBorder: mix(accent, "#ffffff", 0.62),
    accentRgb: `${red}, ${green}, ${blue}`,
    chrome: background,
    chromeDeep: mix(background, "#000000", 0.18),
    chromeText,
    chromeMuted: chromeText === "#000000"
      ? mix(background, "#000000", 0.62)
      : mix(background, "#ffffff", 0.68),
  };
}
