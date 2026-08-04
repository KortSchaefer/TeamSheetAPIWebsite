const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

function jsonResponse(
  request: Request,
  body: Record<string, string>,
  init: ResponseInit = {},
): Response {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init.headers,
    },
  });
}

function methodNotAllowed(request: Request): Response {
  return jsonResponse(request, { detail: "Method Not Allowed" }, {
    status: 405,
    headers: { Allow: "GET, HEAD" },
  });
}

export function rewriteLegacyStaticPath(pathname: string): string | null {
  if (pathname === "/static" || pathname === "/static/") {
    return "/index.html";
  }

  if (!pathname.startsWith("/static/")) {
    return null;
  }

  return pathname.slice("/static".length);
}

async function serveAsset(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(request);
  }

  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  return env.ASSETS.fetch(new Request(assetUrl, request));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(request);
      }

      return jsonResponse(request, {
        status: "ok",
        app: env.APP_NAME,
      });
    }

    if (url.pathname === "/api/version") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(request);
      }

      return jsonResponse(request, {
        app: env.APP_NAME,
        version: env.APP_VERSION,
        environment: env.APP_ENVIRONMENT,
        runtime: "cloudflare-workers",
      });
    }

    if (url.pathname === "/") {
      return serveAsset(request, env, "/index.html");
    }

    const legacyAssetPath = rewriteLegacyStaticPath(url.pathname);
    if (legacyAssetPath !== null) {
      return serveAsset(request, env, legacyAssetPath);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
