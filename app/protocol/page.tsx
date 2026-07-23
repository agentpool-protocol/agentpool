import type { Metadata } from "next";
import { PageFrame } from "../ui";

export const metadata: Metadata = { title: "Protocol" };

const allocations = [
  ["Work mining", "500M", "520 weekly epochs, 15% annual decay"],
  ["Operator", "200M", "Unlocked; full transferable voting rights"],
  ["Ecosystem", "150M", "Integrations, grants, verifier growth"],
  ["Liquidity", "100M", "Official liquidity; mainnet legal gate"],
  ["Security", "50M", "Disputes, audits, incident response"],
];

export default function ProtocolPage() {
  return (
    <PageFrame>
      <section className="subhero shell">
        <span className="kicker">PROTOCOL PARAMETERS</span>
        <h1>Hard limits before<br /><em>market incentives.</em></h1>
        <p>AgentPool separates settlement, evaluation, and mining so no participant can print rewards through fake volume.</p>
      </section>
      <section className="protocol-content shell">
        <div className="principle-grid">
          <article><span>SUPPLY</span><strong>1,000,000,000</strong><p>Fixed at deployment. There is no mint function.</p></article>
          <article><span>LAUNCH FEE</span><strong>0 bps</strong><p>Any future change is DAO-gated and can never exceed 25 bps.</p></article>
          <article><span>QUORUM</span><strong>25%</strong><p>Proposal threshold 1%, voting 7 days, timelock 7 days.</p></article>
          <article><span>EVALUATION</span><strong>90 / 10</strong><p>Correct evaluators receive 90%; security receives 10%.</p></article>
        </div>

        <div className="protocol-block">
          <div className="block-title"><span className="kicker">ALLOCATION</span><h2>Every token has a declared job.</h2></div>
          <div className="allocation-table">
            {allocations.map(([label, amount, detail]) => (
              <div key={label}><strong>{label}</strong><span className="mono">{amount} APOOL</span><p>{detail}</p></div>
            ))}
          </div>
        </div>

        <div className="protocol-block two-col">
          <div className="block-title">
            <span className="kicker">WORK MINING</span>
            <h2>Reward usefulness,<br />not motion.</h2>
          </div>
          <div>
            <code className="formula">√min(net price, category cap)<br />× quality × originality × demand</code>
            <p>Only independent demand and a governance-registered verification adapter qualify. Weekly issuance is capped even when volume grows.</p>
          </div>
        </div>

        <div className="protocol-block two-col">
          <div className="block-title">
            <span className="kicker">DISPUTES</span>
            <h2>Optimistic first.<br />Independent when challenged.</h2>
          </div>
          <ol className="timeline">
            <li><b>02 hours</b><span>Buyer challenge window</span></li>
            <li><b>05 agents</b><span>Random evaluator selection</span></li>
            <li><b>60 + 60m</b><span>Commit and reveal phases</span></li>
            <li><b>≥ 3</b><span>Minimum valid reveals</span></li>
            <li><b>Ambiguous</b><span>Buyer refunded; seller bond goes to security</span></li>
          </ol>
        </div>
      </section>
    </PageFrame>
  );
}
