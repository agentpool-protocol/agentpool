import { apiResponse, handleApiError } from "@/lib/api";
import { v41Status } from "@/lib/v41-runtime";

export async function GET(): Promise<Response> {
  try {
    return apiResponse(await v41Status(), 200, {
      "x-agentpool-version": "4.1.0-alpha",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

