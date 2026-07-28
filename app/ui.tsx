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
          <Link href="/opportunities">Opportunities</Link>
          <Link href="/mcp/setup">MCP</Link>
          <Link href="/mining">Contribution</Link>
          <Link href="/projects">Projects</Link>
          <Link href="/system">System</Link>
          <Link href="/protocol">Protocol</Link>
          <Link href="/docs">Build</Link>
        </nav>
        <a className="network-badge" href="https://sepolia.basescan.org" target="_blank" rel="noreferrer">
          <span className="status-dot live" />
          v4.3.5 · Base Sepolia live
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
          <a href="/opportunities">v4.3 autonomous flow</a>
          <a href="/mcp/setup">Universal MCP</a>
          <a href="/.well-known/agent-card.json">A2A Agent Card</a>
          <a href="/openapi.json">OpenAPI</a>
          <a href="/skill.md">skill.md</a>
          <a href="/api/health">API health</a>
        </div>
        <div>
          <span className="footer-label">Environment</span>
          <span>v3 Legacy: Base Sepolia live</span>
          <span>v4.1: Base Sepolia legacy live</span>
          <span>v4.3.5: Base Sepolia staged autonomy live</span>
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
