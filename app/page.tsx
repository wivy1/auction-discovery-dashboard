import { AuctionDashboard } from "./components/auction-dashboard";
import { cookies } from "next/headers";
import {
  ACCENT_COOKIE_NAME,
  BACKGROUND_COOKIE_NAME,
  DEFAULT_BACKGROUND_COLOR,
  normalizeHexColor,
  resolveAccentColor,
} from "./components/accent-theme";

export default async function Home() {
  const appName = process.env.APP_NAME?.trim() || "Auction Discovery";
  const originPostalCode = process.env.ORIGIN_POSTAL_CODE?.trim() || "90210";
  const cookieStore = await cookies();
  const initialAccent = resolveAccentColor(cookieStore.get(ACCENT_COOKIE_NAME)?.value);
  const initialBackground = normalizeHexColor(
    cookieStore.get(BACKGROUND_COOKIE_NAME)?.value,
    DEFAULT_BACKGROUND_COLOR,
  );
  return (
    <AuctionDashboard
      appName={appName}
      originPostalCode={originPostalCode}
      textProvider={process.env.AI_TEXT_PROVIDER?.trim() || ""}
      textModel={process.env.AI_TEXT_MODEL?.trim() || ""}
      embeddingModel={process.env.AI_EMBEDDING_MODEL?.trim() || ""}
      initialAccent={initialAccent}
      initialBackground={initialBackground}
    />
  );
}
