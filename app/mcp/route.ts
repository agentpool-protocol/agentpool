import {
  handlePublicMcpRequest,
  publicMcpOptions,
} from "@/lib/mcp-http";

export async function POST(request: Request): Promise<Response> {
  return handlePublicMcpRequest(request);
}

export async function GET(request: Request): Promise<Response> {
  return handlePublicMcpRequest(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handlePublicMcpRequest(request);
}

export async function OPTIONS(): Promise<Response> {
  return publicMcpOptions();
}
