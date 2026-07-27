import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { v41Hash } from "@/lib/v41";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  issueId: z.string().min(8).max(100),
  evidenceHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  reproductionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  affectedReleaseId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  salt: z.string().min(16).max(256),
});

export async function POST(request: Request): Promise<Response> {
  return signedV41Write(request, schema, async (input, auth) => {
    const issue = await queryFirst<{
      reporter_address: string;
      issue_commitment: string;
      state: string;
    }>(
      "SELECT reporter_address, issue_commitment, state FROM v41_system_issues WHERE id = ?",
      input.issueId,
    );
    if (!issue || issue.reporter_address.toLowerCase() !== auth.address.toLowerCase()) {
      throw new Error("AUTH_SYSTEM_ISSUE_OWNER");
    }
    if (issue.state !== "COMMITTED") throw new Error("INVALID_SYSTEM_ISSUE_STATE");
    const revealedCommitment = v41Hash({
      evidenceHash: input.evidenceHash,
      reproductionHash: input.reproductionHash,
      affectedReleaseId: input.affectedReleaseId,
      salt: input.salt,
    });
    if (revealedCommitment !== issue.issue_commitment) {
      throw new Error("INVALID_SYSTEM_ISSUE_COMMITMENT");
    }
    const now = Date.now();
    await execute(
      `UPDATE v41_system_issues
       SET evidence_hash = ?, reproduction_hash = ?, affected_release_id = ?,
           state = 'EVIDENCE_REVEALED', revealed_at = ?, updated_at = ?
       WHERE id = ? AND state = 'COMMITTED'`,
      input.evidenceHash,
      input.reproductionHash,
      input.affectedReleaseId,
      now,
      now,
      input.issueId,
    );
    return {
      body: {
        id: input.issueId,
        state: "EVIDENCE_REVEALED",
        fundingOpened: false,
        next:
          "Independent reproductions must confirm the failure before an isolated shadow/canary opportunity is created.",
      },
    };
  });
}

