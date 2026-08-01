import { z } from "zod";
import { accountErasureStateSchema, type AccountErasureState } from "./service";
import { AccountErasureIdempotencyConflictError } from "./store";

export interface AccountErasureHttpDependencies {
  authenticateReverified(request: Request): Promise<{ userId: string } | Response>;
  erase(input: { userId: string; idempotencyKey: string }): Promise<AccountErasureState>;
  requestId?: () => string;
  reportError?: (context: string, error: unknown) => void;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(
  requestId: string,
  status: number,
  code: "invalid_request" | "method_not_allowed" | "conflict" | "internal_error",
  message: string,
): Response {
  return json({ error: { code, message, requestId } }, status);
}

/** Public web-standard POST /v1/account/erasure transport seam. */
export function createAccountErasureHandler(
  dependencies: AccountErasureHttpDependencies,
): (request: Request) => Promise<Response> {
  const nextRequestId = dependencies.requestId ?? (() => crypto.randomUUID());
  return async (request) => {
    const requestId = nextRequestId();
    if (request.method !== "POST") {
      return errorResponse(requestId, 405, "method_not_allowed", "This method is not allowed.");
    }

    const idempotencyKey = z.string().uuid().safeParse(
      request.headers.get("idempotency-key")?.trim(),
    );
    if (!idempotencyKey.success) {
      return errorResponse(
        requestId,
        400,
        "invalid_request",
        "A valid Idempotency-Key is required.",
      );
    }

    let authentication: { userId: string } | Response;
    try {
      authentication = await dependencies.authenticateReverified(request);
    } catch (error) {
      dependencies.reportError?.("account-erasure.authenticate", error);
      return json({ error: { code: "unauthorized", message: "Authentication is required.", requestId } }, 401);
    }
    if (authentication instanceof Response) return authentication;

    try {
      const state = accountErasureStateSchema.parse(await dependencies.erase({
        userId: authentication.userId,
        idempotencyKey: idempotencyKey.data,
      }));
      return json({
        data: {
          generationId: state.generationId,
          status: state.status,
          blockers: state.blockers,
        },
        meta: { requestId },
      }, state.status === "complete" ? 200 : 202);
    } catch (error) {
      if (error instanceof AccountErasureIdempotencyConflictError) {
        return errorResponse(
          requestId,
          409,
          "conflict",
          "The Idempotency-Key is already bound to another account erasure.",
        );
      }
      dependencies.reportError?.("account-erasure.execute", error);
      return errorResponse(
        requestId,
        503,
        "internal_error",
        "Account erasure is not yet confirmed. Retry with the same key.",
      );
    }
  };
}
