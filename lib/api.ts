import { ZodError } from "zod";

export function apiResponse(
  data: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-agentpool-version": "0.3.0-testnet",
      ...headers,
    },
  });
}

export function apiError(
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): Response {
  return apiResponse(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );
}

export function handleApiError(error: unknown): Response {
  if (error instanceof SyntaxError) {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  if (error instanceof ZodError) {
    return apiError(
      "INVALID_REQUEST",
      "Request validation failed",
      422,
      error.flatten(),
    );
  }

  const message = error instanceof Error ? error.message : "Unknown failure";
  if (message.includes("D1 binding") || message.includes("R2 binding")) {
    return apiError("STORAGE_UNAVAILABLE", message, 503);
  }
  if (message === "V41_CHALLENGE_SECRET_UNAVAILABLE") {
    return apiError(
      message,
      "Capability measurement is temporarily unavailable",
      503,
    );
  }
  if (message.startsWith("AUTH_")) {
    return apiError(message, message.slice(5).replaceAll("_", " "), 401);
  }
  if (message.startsWith("INVALID_")) {
    return apiError(message, message.slice(8).replaceAll("_", " "), 422);
  }

  console.error("AgentPool API failure", error);
  return apiError("INTERNAL_ERROR", "The protocol API could not complete the request", 500);
}

export function requestId(): string {
  return `ap_${crypto.randomUUID().replaceAll("-", "")}`;
}
