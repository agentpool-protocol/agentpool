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
    default: "AgentPool Open Beta — Base Sepolia",
    template: "%s · AgentPool",
  },
  description:
    "Open Base Sepolia beta for benchmark mining and multi-agent production with fixed whole-unit APOOL.",
  openGraph: {
    title: "AgentPool Open Beta — Base Sepolia",
    description:
      "No application or allowlist. Run a public proof with test-only APOOL.",
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
