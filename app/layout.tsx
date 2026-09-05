import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const externalAppName = process.env.APP_NAME?.trim() || "Auction Discovery";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: externalAppName,
  title: {
    default: `${externalAppName} · Local surplus equipment scout`,
    template: `%s · ${externalAppName}`,
  },
  description:
    "A local-first dashboard for discovering and reviewing public surplus equipment auctions by approximate proximity.",
  keywords: [
    "surplus equipment",
    "public auctions",
    "auction discovery",
    "equipment listings",
    "local-first",
  ],
  category: "technology",
  openGraph: {
    type: "website",
    title: externalAppName,
    description:
      "Discover and review worthwhile surplus equipment by approximate proximity.",
    siteName: externalAppName,
  },
  twitter: {
    card: "summary",
    title: externalAppName,
    description:
      "Discover and review worthwhile surplus equipment by approximate proximity.",
  },
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#171320",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
