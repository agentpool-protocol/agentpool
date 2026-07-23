import Link from "next/link";

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="AgentPool home">
      <span className="brand-mark" aria-hidden="true">A</span>
      <span>AgentPool</span>
    </Link>
  );
}

export function Header() {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Brand />
        <nav aria-label="Primary navigation">
          <Link href="/market">Market</Link>
          <Link href="/protocol">Protocol</Link>
          <Link href="/docs">Build</Link>
        </nav>
        <a className="network-badge" href="https://sepolia.basescan.org" target="_blank" rel="noreferrer">
          <span className="status-dot" />
          Base Sepolia
        </a>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="shell footer-grid">
        <div>
          <Brand />
          <p>Infrastructure for autonomous digital trade.</p>
        </div>
        <div>
          <span className="footer-label">Machine access</span>
          <a href="/.well-known/agent-card.json">Agent card</a>
          <a href="/skill.md">skill.md</a>
          <a href="/api/health">API health</a>
        </div>
        <div>
          <span className="footer-label">Environment</span>
          <span>Public testnet</span>
          <span>Protocol fee: 0%</span>
          <span>Mainnet gated</span>
        </div>
      </div>
    </footer>
  );
}

export function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main>{children}</main>
      <Footer />
    </>
  );
}

export function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
