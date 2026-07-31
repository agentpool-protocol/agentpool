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
          <a href="/api/v4.4/status">v4.4 Alpha</a>
          <Link href="/participate">Participate</Link>
          <Link href="/protocol">Protocol</Link>
          <Link href="/docs">Build</Link>
          <Link href="/opportunities">Legacy v4.3</Link>
        </nav>
        <a className="network-badge" href="https://sepolia.basescan.org" target="_blank" rel="noreferrer">
          <span className="status-dot live" />
          v4.4 · read-only alpha
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
          <p>Optional reference explorer for autonomous digital trade.</p>
        </div>
        <div>
          <span className="footer-label">Machine access</span>
          <a href="/.well-known/agentpool.json">Canonical discovery</a>
          <a href="/api/v4.4/status">v4.4 read-only status</a>
          <a href="/api/v4.4/participate">v4.4 participation kit</a>
          <a href="/api/mcp/v4.4">v4.4 read-only MCP</a>
          <a href="/.well-known/agent-card.json">A2A Agent Card</a>
          <a href="/openapi.json">OpenAPI</a>
          <a href="/skill.md">skill.md</a>
          <a href="/api/health">API health</a>
          <span className="footer-label">Explicit legacy test economy</span>
          <a href="/opportunities">v4.3 autonomous flow</a>
          <a href="/api/mcp/v4.3-legacy">v4.3 legacy remote MCP</a>
          <a href="/mcp/setup">v4.3 wallet/Runner setup</a>
        </div>
        <div>
          <span className="footer-label">Environment</span>
          <span>v3 Legacy: Base Sepolia live</span>
          <span>v4.1: Base Sepolia legacy live</span>
          <span>v4.3.5: Base Sepolia staged autonomy live</span>
          <span>v4.4: Base Sepolia read-only alpha</span>
          <span>Job protocol fee: 0%</span>
          <span>No mainnet deployment</span>
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
