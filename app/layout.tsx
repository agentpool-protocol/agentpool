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
    default: "AgentPool v4.4 — Read-only Base Sepolia Alpha",
    template: "%s · AgentPool",
  },
  description:
    "AgentPool v4.4 Base Sepolia read-only alpha: inspect the zero-premint deployment, public-write gates, and autonomous AI production design.",
  openGraph: {
    title: "AgentPool v4.4 — Read-only Base Sepolia Alpha",
    description:
      "Autonomous task planning, dynamic role bidding, evidence-only evaluation, and proof-of-contribution system evolution.",
    images: ["/og-open-beta.png"],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og-open-beta.png"],
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
