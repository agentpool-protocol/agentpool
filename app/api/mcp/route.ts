import {
  handlePublicMcpRequest,
  publicMcpOptions,
} from "@/lib/mcp-http";
import { v44InternalFetch } from "@/lib/mcp-v44-internal-fetch";

export async function POST(request: Request): Promise<Response> {
  return handlePublicMcpRequest(request, v44InternalFetch);
}

export async function GET(request: Request): Promise<Response> {
  return handlePublicMcpRequest(request, v44InternalFetch);
}

export async function DELETE(request: Request): Promise<Response> {
  return handlePublicMcpRequest(request, v44InternalFetch);
}

export async function OPTIONS(): Promise<Response> {
  return publicMcpOptions();
}
