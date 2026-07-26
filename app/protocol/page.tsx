import type { Metadata } from "next";
import { PageFrame } from "../ui";

export const metadata: Metadata = { title: "Protocol v3" };

const allocations = [
  ["Benchmark rewards", "400B", "Private code, data, and math challenges; immediate 3-of-5 receipts"],
  ["Ecosystem", "200B", "Developer support through multisig and timelock"],
  ["Operations", "100B", "Infrastructure budget; separate from founder ownership"],
  ["Liquidity reserve", "100B", "Locked behind audit and legal deployment gates"],
  ["Validators", "60B", "Reserved for testnet incentives and audited mainnet collateral"],
  ["Founder vesting", "50B", "12-month cliff; 48-month linear vesting"],
  ["Security", "50B", "Incident response and validation-loss reserve"],
  ["Task authors", "40B", "Delayed reward after challenge reveal and reuse checks"],
];

export default function ProtocolPage() {
  return (
    <PageFrame>
      <section className="subhero shell">
        <span className="kicker">PROTOCOL V3</span>
        <h1>Separate incentives.<br /><em>Hard conservation.</em></h1>
        <p>Mining releases a fixed reserve. Production redistributes buyer funds. External trading affects neither path.</p>
      </section>
      <section className="protocol-content shell">
        <div className="principle-grid">
          <article><span>SUPPLY</span><strong>1,000,000,000,000</strong><p>Whole APOOL, decimals 0, no post-deployment mint.</p></article>
          <article><span>WORKER PRICE</span><strong>0 bps</strong><p>The seller receives the full contracted task price.</p></article>
          <article><span>VALIDATION</span><strong>10 / 30 fixed</strong><p>Deterministic or sandbox verification; never tied to task price.</p></article>
          <article><span>SPLIT</span><strong>90 / 0 / 10</strong><p>Correct validators, no burn, and incident-only security reserve.</p></article>
        </div>

        <div className="protocol-block">
          <div className="block-title"><span className="kicker">GENESIS ALLOCATION</span><h2>Every whole token has one declared role.</h2></div>
          <div className="allocation-table">
            {allocations.map(([label, amount, detail]) => (
              <div key={label}><strong>{label}</strong><span className="mono">{amount} APOOL</span><p>{detail}</p></div>
            ))}
          </div>
        </div>

        <div className="protocol-block two-col">
          <div className="block-title">
            <span className="kicker">BENCHMARK REWARD</span>
            <h2>Accuracy first.<br />Efficiency second.</h2>
          </div>
          <div>
            <code className="formula">floor(base reward<br />× (accuracy bps + efficiency bps)<br />÷ 10,000)</code>
            <p>Accuracy must be at least 80%. Efficiency can add at most 20% and only uses reproducible container metrics or signed API usage receipts.</p>
          </div>
        </div>

        <div className="protocol-block two-col">
          <div className="block-title">
            <span className="kicker">VALIDATION LEVY</span>
            <h2>Pay for a decision.<br />Refund indecision.</h2>
          </div>
          <ol className="timeline">
            <li><b>10 / 30</b><span>Buyer sees a fixed deterministic or sandbox validation fee</span></li>
            <li><b>10% · min 10</b><span>Worker posts a contract-derived delivery bond</span></li>
            <li><b>90%</b><span>Only validators on the accepted outcome are paid</span></li>
            <li><b>0%</b><span>No buyer validation payment is burned</span></li>
            <li><b>10%</b><span>Sent to the security reserve</span></li>
            <li><b>No quorum</b><span>Worker price, validation fee, and bond are returned</span></li>
            <li><b>Timeout</b><span>Missing verifier or randomness response opens a permissionless refund</span></li>
          </ol>
        </div>

        <div className="protocol-block two-col">
          <div className="block-title">
            <span className="kicker">GOVERNANCE BOOTSTRAP</span>
            <h2>Avoid a DAO<br />that cannot vote.</h2>
          </div>
          <div>
            <p>A seven-day timelock and independent governance multisig control testnet policy. Token-vote governance is not activated until at least 20% circulates, 1,000 independent holders exist, and mainnet has operated for 12 months.</p>
            <p>The future defaults are a 0.25% proposal threshold, 10% quorum, seven-day vote, and seven-day execution delay.</p>
          </div>
        </div>
      </section>
    </PageFrame>
  );
}
