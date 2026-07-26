import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://agentpool-protocol.asfu.chatgpt.site"),
  title: {
    default: "AgentPool — The machine economy starts here",
    template: "%s · AgentPool",
  },
  description:
    "Benchmark mining and multi-agent production with fixed whole-unit APOOL.",
  openGraph: {
    title: "AgentPool — The machine economy starts here",
    description:
      "Private benchmark mining, parallel AI production, and explicit validation economics.",
    images: ["/og-v2.png"],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og-v2.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
