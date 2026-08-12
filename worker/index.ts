import { apiError, jsonResponse, methodNotAllowed } from "./http";
import { runtimeBindings, voiceRuntimeBindings } from "./runtime";
import { currentUser, loginJson, loginToken, logout, register } from "./routes/auth";
import { routeInventoryDomain } from "./routes/inventory-domain";
import { routeIngredientCatalog } from "./routes/ingredient-catalog";
import { routeVoiceInventory } from "./routes/voice-inventory";
import { routeAGMFloor } from "./routes/agm-floor";
import { routePOSConfiguration } from "./routes/pos-configuration";
import { routePOSTerminal } from "./routes/pos-terminal";
import { routeWorkforce } from "./routes/workforce";
import { routeTeamSheets } from "./routes/team-sheets";
import { routeGiftTracker, routePayouts } from "./routes/accounting";
import { routePyos } from "./routes/pyos";
import { routeImports } from "./routes/imports";
import {
  cleanupExpiredVoiceAudio,
  cleanupVoiceAudioRoute,
  createVoiceAudioUploadTarget,
  downloadVoiceAudio,
  uploadVoiceAudio,
} from "./routes/voice-audio";

export { AGMServiceRoom } from "./durable-objects/agm-service";

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
    return methodNotAllowed(request, "GET, HEAD");
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
        return methodNotAllowed(request, "GET, HEAD");
      }

      return jsonResponse(request, {
        status: "ok",
        app: env.APP_NAME,
      });
    }

    if (url.pathname === "/api/version") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(request, "GET, HEAD");
      }

      return jsonResponse(request, {
        app: env.APP_NAME,
        version: env.APP_VERSION,
        environment: env.APP_ENVIRONMENT,
        runtime: "cloudflare-workers",
      });
    }

    const audioMatch = /^\/inventory\/voice\/sessions\/(\d+)\/audio\/([0-9a-f-]{36})$/u.exec(
      url.pathname,
    );
    const audioTargetMatch = /^\/inventory\/voice\/sessions\/(\d+)\/audio-upload$/u.exec(
      url.pathname,
    );
    const isAudioCleanup = url.pathname === "/inventory/voice/maintenance/cleanup-audio";
    if (audioMatch !== null || audioTargetMatch !== null || isAudioCleanup) {
      const bindings = voiceRuntimeBindings(env);
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        if (audioTargetMatch !== null) {
          return request.method === "POST"
            ? await createVoiceAudioUploadTarget(request, Number(audioTargetMatch[1]), bindings)
            : methodNotAllowed(request, "POST");
        }
        if (audioMatch !== null) {
          const sessionId = Number(audioMatch[1]);
          const uploadId = audioMatch[2];
          if (request.method === "PUT") {
            return uploadVoiceAudio(request, sessionId, uploadId, bindings);
          }
          if (request.method === "GET" || request.method === "HEAD") {
            return downloadVoiceAudio(request, sessionId, uploadId, bindings);
          }
          return methodNotAllowed(request, "GET, HEAD, PUT");
        }
        return request.method === "POST"
          ? await cleanupVoiceAudioRoute(request, bindings)
          : methodNotAllowed(request, "POST");
      } catch (error) {
        console.error(JSON.stringify({
          message: "Worker voice audio request failed",
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : "Unknown error",
        }));
        return apiError(request, 500, "Internal Server Error");
      }
    }

    const bindings = runtimeBindings(env);
    if (url.pathname.startsWith("/pos/")) {
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        const configuration = await routePOSConfiguration(request, url, bindings);
        if (configuration !== null) return configuration;
        const terminal = await routePOSTerminal(request, url, bindings);
        if (terminal !== null) return terminal;
      } catch (error) {
        console.error(JSON.stringify({
          message: "Worker POS request failed",
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : "Unknown error",
        }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    const workforcePath = [
      "/employees", "/sections", "/shifts", "/seasons", "/store-preferences", "/cobrands",
      "/daily-rosters", "/teamsheet-presets",
    ].some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
    if (workforcePath) {
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        const response = await routeWorkforce(request, url, bindings);
        if (response !== null) return response;
      } catch (error) {
        console.error(JSON.stringify({ message: "Worker workforce request failed", method: request.method, path: url.pathname, error: error instanceof Error ? error.message : "Unknown error" }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    if (url.pathname === "/team-sheets" || url.pathname.startsWith("/team-sheets/")) {
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        const response = await routeTeamSheets(request, url, bindings);
        if (response !== null) return response;
      } catch (error) {
        console.error(JSON.stringify({ message: "Worker team sheet request failed", method: request.method, path: url.pathname, error: error instanceof Error ? error.message : "Unknown error" }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    const accountingPath = url.pathname === "/gift-tracker" || url.pathname.startsWith("/payouts/") || url.pathname.startsWith("/pyos/");
    if (accountingPath) {
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        const response = await routeGiftTracker(request, url, bindings) ?? await routePayouts(request, url, bindings) ?? await routePyos(request, url, bindings);
        if (response !== null) return response;
      } catch (error) {
        console.error(JSON.stringify({ message: "Worker accounting request failed", method: request.method, path: url.pathname, error: error instanceof Error ? error.message : "Unknown error" }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    if (url.pathname.startsWith("/imports/")) {
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        const response = await routeImports(request, url, bindings);
        if (response !== null) return response;
      } catch (error) {
        console.error(JSON.stringify({ message: "Worker import request failed", method: request.method, path: url.pathname, error: error instanceof Error ? error.message : "Unknown error" }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    if (url.pathname.startsWith("/agm/")) {
      if (bindings === null || env.AGM_SERVICE === undefined) {
        return apiError(request, 500, "Internal Server Error");
      }
      try {
        const response = await routeAGMFloor(request, url, {
          ...bindings,
          serviceRooms: env.AGM_SERVICE,
        });
        if (response !== null) return response;
      } catch (error) {
        console.error(JSON.stringify({
          message: "Worker AGM floor request failed",
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : "Unknown error",
        }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    if (url.pathname === "/ingredient-catalog" || url.pathname.startsWith("/ingredient-catalog/")) {
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        const response = await routeIngredientCatalog(request, url, bindings);
        if (response !== null) return response;
      } catch (error) {
        console.error(JSON.stringify({ message: "Worker ingredient catalog request failed", method: request.method, path: url.pathname, error: error instanceof Error ? error.message : "Unknown error" }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    if (url.pathname.startsWith("/inventory/voice/")) {
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        const response = await routeVoiceInventory(request, url, bindings);
        if (response !== null) return response;
      } catch (error) {
        console.error(JSON.stringify({
          message: "Worker voice inventory request failed",
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : "Unknown error",
        }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    if (url.pathname.startsWith("/inventory/") && !url.pathname.startsWith("/inventory/voice/")) {
      if (bindings === null) return apiError(request, 500, "Internal Server Error");
      try {
        const response = await routeInventoryDomain(request, url, bindings);
        if (response !== null) return response;
      } catch (error) {
        console.error(JSON.stringify({
          message: "Worker inventory request failed",
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : "Unknown error",
        }));
        return apiError(request, 500, "Internal Server Error");
      }
    }
    const apiPath =
      url.pathname === "/auth/login" ||
      url.pathname === "/auth/register" ||
      url.pathname === "/auth/token" ||
      url.pathname === "/auth/me" ||
      url.pathname === "/auth/logout";
    if (apiPath) {
      if (bindings === null) {
        return apiError(request, 500, "Internal Server Error");
      }
      try {
        if (url.pathname === "/auth/login") {
          return request.method === "POST"
            ? await loginJson(request, bindings)
            : methodNotAllowed(request, "POST");
        }
        if (url.pathname === "/auth/register") {
          return request.method === "POST"
            ? await register(request, bindings)
            : methodNotAllowed(request, "POST");
        }
        if (url.pathname === "/auth/token") {
          return request.method === "POST"
            ? await loginToken(request, bindings)
            : methodNotAllowed(request, "POST");
        }
        if (url.pathname === "/auth/me") {
          return request.method === "GET"
            ? await currentUser(request, bindings)
            : methodNotAllowed(request, "GET");
        }
        if (url.pathname === "/auth/logout") {
          return request.method === "POST"
            ? logout(request)
            : methodNotAllowed(request, "POST");
        }
        return apiError(request, 404, "Not Found");
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "Worker API request failed",
            method: request.method,
            path: url.pathname,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
        return apiError(request, 500, "Internal Server Error");
      }
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
  async scheduled(controller, env): Promise<void> {
    const bindings = voiceRuntimeBindings(env);
    if (bindings === null) {
      console.error(JSON.stringify({ message: "Voice audio cleanup bindings unavailable" }));
      return;
    }
    const removed = await cleanupExpiredVoiceAudio(bindings, new Date(controller.scheduledTime));
    console.log(JSON.stringify({ message: "Voice audio cleanup complete", removed }));
  },
} satisfies ExportedHandler<Env>;
