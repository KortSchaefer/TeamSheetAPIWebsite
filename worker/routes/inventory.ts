import { jsonResponse } from "../http";
import {
  InventoryLocationRepository,
  serializeInventoryLocation,
} from "../repositories/inventory-locations";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest } from "./auth";

export async function listInventoryLocations(
  request: Request,
  bindings: RuntimeBindings,
): Promise<Response> {
  const authentication = await authenticateRequest(request, bindings);
  if (authentication.response !== null) return authentication.response;

  const locations = await new InventoryLocationRepository(bindings.database).listActive();
  return jsonResponse(request, locations.map(serializeInventoryLocation));
}
