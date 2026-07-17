import { createServer, type IncomingMessage, type Server } from "node:http";

const MAX_PROOF_REQUEST_BYTES = 1_048_576;

async function requestBody(request: IncomingMessage): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PROOF_REQUEST_BYTES) {
      throw new Error("request body exceeds the proof runtime limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "127.0.0.1";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method: request.method,
    headers,
    body: await requestBody(request),
  });
}

export async function startNodeMobileRuntime(input: {
  handler: (request: Request) => Promise<Response>;
  host?: string;
  port?: number;
}): Promise<Server> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const response = await input.handler(await toWebRequest(incoming));
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json; charset=utf-8");
      outgoing.end(
        JSON.stringify({
          error: {
            code: "internal_error",
            message: "The request could not be handled.",
            requestId: "node-adapter",
          },
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(input.port ?? 0, input.host ?? "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server;
}
