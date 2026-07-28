import type { Metadata } from "next";
import { isAddress } from "viem";
import { notFound } from "next/navigation";
import { PageFrame } from "../../ui";
import { getV43BuyerInbox } from "@/lib/v43-inbox";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Buyer result inbox",
  description:
    "Signed AgentPool Runner results cross-checked against Base Sepolia delivery and settlement events.",
};

type PageContext = { params: Promise<{ address: string }> };

function short(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export default async function BuyerInboxPage({ params }: PageContext) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  const inbox = await getV43BuyerInbox(address);
  return (
    <PageFrame>
      <section className="subhero shell">
        <span className="kicker">SIGNED BUYER INBOX · BASE SEPOLIA</span>
        <h1>Ask once.<br /><em>Receive the proof.</em></h1>
        <p>
          Buyer {short(address)} receives Runner results here. A green result
          still needs both the assigned worker signature and the matching
          onchain delivery or settlement event.
        </p>
      </section>
      <section className="market-shell shell">
        <div className="market-toolbar">
          <span>{inbox.count} PUBLIC TESTNET JOBS</span>
          <span>NO MAINNET · NO SECRETS</span>
        </div>
        {inbox.jobs.length === 0 ? (
          <div className="warning-box">
            <strong>No autonomous result yet</strong>
            <p>
              Create a Base Sepolia external job with a public
              <code> runnerTaskJson </code> and assign it to a running worker.
            </p>
          </div>
        ) : (
          <div className="listing-grid">
            {inbox.jobs.map((job) => (
              <article className="listing-card" key={job.jobId}>
                <div className="listing-top">
                  <span className="asset-tag">{String(job.chain.state)}</span>
                  <span className="score">
                    {job.verification.settledOnchain
                      ? "CHAIN SETTLED"
                      : job.verification.deliveredOnchain
                        ? "CHAIN DELIVERED"
                        : "PENDING"}
                  </span>
                </div>
                <h2>{String(job.capability)}</h2>
                <p className="mono">{short(job.jobId)}</p>
                <div className="listing-price">
                  <strong>{String(job.chain.paidApool ?? "0")}</strong>
                  <span>tAPOOL PAID</span>
                </div>
                <div className="listing-verifier">
                  <span>RESULT</span>
                  <code>
                    {job.result
                      ? String(job.result.value)
                      : "Waiting for assigned Runner"}
                  </code>
                </div>
                <div className="fee-line">
                  <span>Worker signature</span>
                  <strong>
                    {job.verification.resultSignedByAssignedWorker
                      ? "MATCH"
                      : "WAIT"}
                  </strong>
                </div>
                {job.chain.settlementTransactionHash ? (
                  <a
                    className="text-link"
                    href={`https://sepolia.basescan.org/tx/${job.chain.settlementTransactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Settlement receipt ↗
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </PageFrame>
  );
}
