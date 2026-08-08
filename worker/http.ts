const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export function jsonResponse(
  request: Request,
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function apiError(
  request: Request,
  status: number,
  detail: string,
  headers: HeadersInit = {},
): Response {
  return jsonResponse(request, { detail }, { status, headers });
}

export function methodNotAllowed(request: Request, allow: string): Response {
  return apiError(request, 405, "Method Not Allowed", { Allow: allow });
}

export function validationError(
  request: Request,
  errors: Array<Record<string, unknown>>,
): Response {
  return jsonResponse(request, { detail: errors }, { status: 422 });
}
