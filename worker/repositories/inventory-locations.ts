export interface InventoryLocationRecord {
  id: number;
  name: string;
  description: string | null;
  active: number | boolean;
}

export class InventoryLocationRepository {
  constructor(private readonly database: D1Database) {}

  async listActive(): Promise<InventoryLocationRecord[]> {
    const result = await this.database
      .prepare(
        `SELECT id, name, description, active
         FROM inventory_locations
         WHERE active = 1
         ORDER BY name`,
      )
      .all<InventoryLocationRecord>();
    return result.results;
  }
}

export function serializeInventoryLocation(
  location: InventoryLocationRecord,
): Record<string, unknown> {
  return {
    name: location.name,
    description: location.description,
    active: Boolean(location.active),
    id: location.id,
  };
}
