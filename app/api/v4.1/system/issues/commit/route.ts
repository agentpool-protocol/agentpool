import { z } from "zod";
import { requestId } from "@/lib/api";
import { execute } from "@/db/runtime";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  issueCommitment: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function POST(request: Request): Promise<Response> {
  return signedV41Write(request, schema, async (input, auth) => {
    const id = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO v41_system_issues
        (id, reporter_address, issue_commitment, state, created_at, updated_at)
       VALUES (?, ?, ?, 'COMMITTED', ?, ?)`,
      id,
      auth.address,
      input.issueCommitment,
      now,
      now,
    );
    return {
      body: {
        id,
        state: "COMMITTED",
        fundingOpened: false,
        next: "Reveal reproducible evidence. A report cannot open an emission budget by itself.",
      },
      status: 201,
    };
  });
}

