import { buildDiscoveryManifest } from "@/lib/discovery";

type JsonRecord = Record<string, unknown>;

function extractText(payload: JsonRecord): string {
  const message =
    payload.message && typeof payload.message === "object"
      ? (payload.message as JsonRecord)
      : payload;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as JsonRecord;
      if (typeof record.text === "string") return record.text;
      if (record.data && typeof record.data === "object") {
        return JSON.stringify(record.data);
      }
      return "";
    })
    .join(" ")
    .trim();
}

async function readJson(
  origin: string,
  path: string,
  fetcher: typeof fetch,
): Promise<JsonRecord> {
  const response = await fetcher(new URL(path, origin), {
    headers: { accept: "application/json" },
  });
  const payload = (await response.json()) as JsonRecord;
  if (!response.ok) {
    throw new Error(`AgentPool ${path} returned ${response.status}`);
  }
  return payload;
}

function a2aMessage(payload: JsonRecord): Response {
  return Response.json(
    {
      messageId: crypto.randomUUID(),
      role: "ROLE_AGENT",
      parts: [
        {
          text: JSON.stringify(payload, null, 2),
        },
      ],
      metadata: {
        readOnly: true,
        canMint: false,
        canSign: false,
        canMoveFunds: false,
      },
    },
    {
      headers: {
        "content-type": "application/a2a+json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

export async function handleA2ADiscoveryRequest(
  request: Request,
  fetcher: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        allow: "GET, POST, OPTIONS",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  if (url.pathname === "/a2a/v1" && request.method === "GET") {
    return a2aMessage({
      purpose: "AgentPool read-only discovery agent",
      sendMessage: `${origin}/a2a/v1/message:send`,
      agentCard: `${origin}/.well-known/agent-card.json`,
      examples: [
        "Show AgentPool status",
        "List BASIC opportunities",
        "List proven artifacts",
        "How can another AI connect?",
      ],
    });
  }

  if (
    url.pathname !== "/a2a/v1/message:send" ||
    request.method !== "POST"
  ) {
    return Response.json(
      { error: "A2A method or path not supported" },
      { status: 405, headers: { allow: "GET, POST, OPTIONS" } },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 64 * 1024) {
    return Response.json({ error: "A2A request too large" }, { status: 413 });
  }

  let input: JsonRecord;
  try {
    input = (await request.json()) as JsonRecord;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const query = extractText(input).toLowerCase();
  let payload: JsonRecord;
  if (
    query.includes("opportunit") ||
    query.includes("market") ||
    query.includes("기회") ||
    query.includes("채굴")
  ) {
    const market = ["capability", "basic", "system", "external"].find((item) =>
      query.includes(item),
    );
    payload = await readJson(
      origin,
      `/api/v4.1/opportunities${market ? `?market=${market.toUpperCase()}` : ""}`,
      fetcher,
    );
  } else if (
    query.includes("artifact") ||
    query.includes("아티팩트") ||
    query.includes("결과물")
  ) {
    payload = await readJson(origin, "/api/v4.1/artifacts", fetcher);
  } else if (
    query.includes("status") ||
    query.includes("상태") ||
    query.includes("emission") ||
    query.includes("발행")
  ) {
    payload = await readJson(origin, "/api/v4.1/status", fetcher);
  } else {
    payload = buildDiscoveryManifest(origin);
  }

  return a2aMessage(payload);
}
