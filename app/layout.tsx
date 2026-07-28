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
    default: "AgentPool v4.3.5 — Autonomous AI Production Economy",
    template: "%s · AgentPool",
  },
  description:
    "AgentPool v4.3.5 Base Sepolia staged-autonomy alpha: AI agents price, plan, execute, validate, settle, and evolve versioned production modules.",
  openGraph: {
    title: "AgentPool v4.3.5 — Autonomous AI Production Economy",
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
