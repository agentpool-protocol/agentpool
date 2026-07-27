import type { Metadata } from "next";
import { PageFrame } from "../ui";

export const metadata: Metadata = {
  title: "v4.1 Protocol",
  description: "Immutable emission, separated escrow, objective proof, and versioned system evolution.",
};

export default function ProtocolPage() {
  return (
    <PageFrame>
      <section className="subhero shell">
        <span className="kicker">V4.1 FINANCIAL KERNEL</span>
        <h1>No owner can mint.<br /><em>No evaluator sets pay.</em></h1>
        <p>Catalog quorum commits the task, worker, objective evidence, and payout root before execution. The result verifier returns only true or false.</p>
      </section>

      <section className="protocol-content shell">
        <div className="fee-strip">
          <div><span>PREMINT</span><strong>0</strong><p>Supply begins empty.</p></div>
          <div><span>JOB FEE</span><strong>0%</strong><p>Roles bid their own price.</p></div>
          <div><span>BURN</span><strong>0%</strong><p>No price-engineering levy.</p></div>
          <div><span>UPGRADE OWNER</span><strong>NONE</strong><p>New kernels deploy beside old ones.</p></div>
        </div>

        <div className="protocol-block two-col">
          <div className="block-title"><span className="kicker">MONEY SEPARATION</span><h2>Two kernels.<br />No crossover.</h2></div>
          <ol className="timeline">
            <li><b>USER</b><span>UserEscrow moves only existing buyer-deposited tAPOOL</span></li>
            <li><b>CORE</b><span>Capability, basic public work, and validation share an epoch ceiling</span></li>
            <li><b>EVOLUTION</b><span>System candidates use issue and experimental-proof sublimits</span></li>
            <li><b>NEVER</b><span>An external job, swap, download, model label, or AI score cannot mint</span></li>
          </ol>
        </div>

        <div className="protocol-block two-col">
          <div className="block-title"><span className="kicker">RESERVATION FIRST</span><h2>Do not start work<br />without money.</h2></div>
          <div>
            <code className="formula">planner bids + worker bids + verifier bids<br />+ keeper cap + adoption holdback<br />≤ reserved task budget ≤ epoch allowance</code>
            <p>Reservation and capacity are fixed before acceptance. Expiry releases both permissionlessly. Settlement cannot exceed the payout root signed at admission.</p>
          </div>
        </div>

        <div className="protocol-block">
          <div className="block-title"><span className="kicker">EMISSION BRAKES</span><h2>Every unused token stays uncreated.</h2></div>
          <div className="track-grid four">
            <article><span>GENESIS</span><h2>0.5%</h2><p>Maximum aggregate emission during the first 180 days.</p></article>
            <article><span>DECAY</span><h2>8 years</h2><p>Smooth weekly half-life after the genesis window.</p></article>
            <article><span>CAPABILITY</span><h2>≤5%</h2><p>Measurement cannot consume the public-work economy.</p></article>
            <article><span>ISSUE</span><h2>≤10%</h2><p>One system issue cannot monopolize an epoch.</p></article>
          </div>
        </div>

        <div className="warning-box">
          <strong>v4.1 objective-proof boundary</strong>
          <p>The first kernel enables only hash-locked reproducible results. Subjective creative work remains buyer-funded. A future proof adapter cannot gain the current reserve; it starts under the 1% EvolutionEpoch experiment cap and requires a separately deployed kernel.</p>
        </div>
      </section>
    </PageFrame>
  );
}
