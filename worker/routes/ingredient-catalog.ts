import { apiError, jsonResponse, methodNotAllowed } from "../http";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest } from "./auth";
import defaultCatalog from "../../data/ingredient_catalog.json" with { type: "json" };
import barCatalog from "../../data/bar_inventory_catalog.json" with { type: "json" };

type Row = Record<string, unknown>;
type CatalogItem = { id:string;name:string;category?:string;stage?:string;parent_ids?:string[];process?:string;added_to_complete_lineage?:boolean;source_correction?:string;resolution_needed?:string;inventory_department?:string;stockable?:boolean;inventory_base_unit?:string;inventory_purchase_unit?:string };

async function authenticated(request: Request, bindings: RuntimeBindings): Promise<Response | null> {
  const auth = await authenticateRequest(request, bindings);
  return auth.response;
}

function randomId():number{return crypto.getRandomValues(new Uint32Array(1))[0]&0x7fffffff||1}
async function managerAuth(request:Request,bindings:RuntimeBindings):Promise<Response|null>{const auth=await authenticateRequest(request,bindings);if(auth.response!==null||auth.user===null)return auth.response;return ["MANAGER","ADMIN"].includes(auth.user.role)?null:apiError(request,403,"Manager or admin access required")}
async function sha(text:string):Promise<string>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("")}
function model(data:unknown):{schema_version:string;items:CatalogItem[];[key:string]:unknown}{return (data as {inventory_process_model:{schema_version:string;items:CatalogItem[]}}).inventory_process_model}

async function importCatalog(request:Request,bindings:RuntimeBindings,data:unknown,sourceName:string,dryRun:boolean):Promise<Response>{
  const denied=await managerAuth(request,bindings);if(denied!==null)return denied;const catalog=model(data),items=catalog.items,externalIds=new Set(items.map(item=>item.id));const known=await bindings.database.prepare("SELECT external_id FROM ingredients WHERE external_id IS NOT NULL").all<{external_id:string}>();known.results.forEach(row=>externalIds.add(row.external_id));const missing=items.flatMap(item=>(item.parent_ids??[]).filter(parent=>!externalIds.has(parent))).filter((value,index,list)=>list.indexOf(value)===index);if(missing.length)return apiError(request,400,`Catalog has missing parent IDs: ${missing.slice(0,8).join(", ")}`);
  const source=JSON.stringify(data),sourceHash=await sha(source),relationships=items.reduce((sum,item)=>sum+(item.parent_ids?.length??0),0);if(dryRun)return jsonResponse(request,{schema_version:catalog.schema_version,source_name:sourceName,source_sha256:sourceHash,item_count:items.length,relationship_count:relationships,dry_run:true});
  const existing=await bindings.database.prepare("SELECT id,external_id FROM ingredients WHERE external_id IS NOT NULL").all<{id:number;external_id:string}>();const ids=new Map(existing.results.map(row=>[row.external_id,row.id]));for(const item of items)if(!ids.has(item.id))ids.set(item.id,randomId());const statements:D1PreparedStatement[]=[];
  for(const item of items)statements.push(bindings.database.prepare(`INSERT INTO ingredients(id,name,unit,active,external_id,normalized_name,category,stage,process,added_to_complete_lineage,source_correction,resolution_needed,catalog_schema_version,catalog_metadata)
    VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(name) DO UPDATE SET external_id=excluded.external_id,normalized_name=excluded.normalized_name,category=excluded.category,stage=excluded.stage,process=excluded.process,added_to_complete_lineage=excluded.added_to_complete_lineage,source_correction=excluded.source_correction,resolution_needed=excluded.resolution_needed,catalog_schema_version=excluded.catalog_schema_version,active=1`)
    .bind(ids.get(item.id),item.name,item.inventory_base_unit??"each",item.id,item.name.toLowerCase().replace(/[^a-z0-9]+/gu," ").trim(),item.category??null,item.stage??"unresolved",item.process??null,item.added_to_complete_lineage?1:0,item.source_correction??null,item.resolution_needed??null,catalog.schema_version));
  statements.push(bindings.database.prepare("DELETE FROM ingredient_lineage WHERE child_ingredient_id IN (SELECT id FROM ingredients WHERE catalog_schema_version=?)").bind(catalog.schema_version));for(const item of items)(item.parent_ids??[]).forEach((parent,index)=>statements.push(bindings.database.prepare("INSERT OR IGNORE INTO ingredient_lineage(id,child_ingredient_id,parent_ingredient_id,order_index) VALUES(?,?,?,?)").bind(randomId(),ids.get(item.id),ids.get(parent),index)));
  const importId=randomId();statements.push(bindings.database.prepare(`INSERT INTO ingredient_catalog_imports(id,schema_version,source_name,source_sha256,item_count,relationship_count,catalog_metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(importId,catalog.schema_version,sourceName,sourceHash,items.length,relationships,JSON.stringify(Object.fromEntries(Object.entries(catalog).filter(([key])=>!["items","schema_version"].includes(key))))));await bindings.database.batch(statements);
  return jsonResponse(request,{id:importId,schema_version:catalog.schema_version,source_name:sourceName,source_sha256:sourceHash,item_count:items.length,relationship_count:relationships,created_at:new Date().toISOString()});
}

async function importBar(request:Request,url:URL,bindings:RuntimeBindings):Promise<Response>{const dry=url.searchParams.get("dry_run")==="true";if(dry)return importCatalog(request,bindings,barCatalog,"bar_inventory_catalog.json",true);const imported=await importCatalog(request,bindings,barCatalog,"bar_inventory_catalog.json",false);if(!imported.ok)return imported;const denied=await managerAuth(request,bindings);if(denied!==null)return denied;const locationName=(url.searchParams.get("location_name")??"Bar").trim(),catalog=model(barCatalog);let location=await bindings.database.prepare("SELECT id FROM inventory_locations WHERE name=?").bind(locationName).first<{id:number}>();if(!location){location={id:randomId()};await bindings.database.prepare("INSERT INTO inventory_locations(id,name,description,active,created_at,updated_at) VALUES(?,?,'Bar inventory',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(location.id,locationName).run()};let activated=0;const statements:D1PreparedStatement[]=[];for(const item of catalog.items.filter(item=>item.stockable)){const ingredient=await bindings.database.prepare("SELECT id FROM ingredients WHERE external_id=?").bind(item.id).first<{id:number}>();if(!ingredient)continue;const exists=await bindings.database.prepare("SELECT id FROM inventory_items WHERE ingredient_id=?").bind(ingredient.id).first<{id:number}>();if(exists){statements.push(bindings.database.prepare("UPDATE inventory_items SET active=1,default_location_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(location.id,exists.id))}else{statements.push(bindings.database.prepare(`INSERT INTO inventory_items(id,ingredient_id,name,category,sku,base_unit,purchase_unit,purchase_to_base,default_location_id,cost_cents,shelf_life_days,active,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?,1,?,0,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(randomId(),ingredient.id,item.name,item.category??null,item.inventory_base_unit??"each",item.inventory_purchase_unit??item.inventory_base_unit??"each",location.id));activated++}}if(statements.length)await bindings.database.batch(statements);return jsonResponse(request,{location_id:location.id,location_name:locationName,catalog_item_count:catalog.items.length,activated_item_count:activated});}

async function serialize(database: D1Database, rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => Number(row.id));
  const placeholders = ids.map(() => "?").join(",");
  const [parents, children, activated] = await database.batch([
    database.prepare(`SELECT il.child_ingredient_id AS id, p.external_id
      FROM ingredient_lineage il JOIN ingredients p ON p.id = il.parent_ingredient_id
      WHERE il.child_ingredient_id IN (${placeholders}) ORDER BY il.child_ingredient_id, il.order_index`).bind(...ids),
    database.prepare(`SELECT il.parent_ingredient_id AS id, c.external_id
      FROM ingredient_lineage il JOIN ingredients c ON c.id = il.child_ingredient_id
      WHERE il.parent_ingredient_id IN (${placeholders}) ORDER BY il.parent_ingredient_id, c.name`).bind(...ids),
    database.prepare(`SELECT ingredient_id AS id, id AS inventory_item_id FROM inventory_items
      WHERE ingredient_id IN (${placeholders}) ORDER BY active DESC, id`).bind(...ids),
  ]);
  const parentMap = new Map<number, string[]>();
  const childMap = new Map<number, string[]>();
  const activeMap = new Map<number, number>();
  for (const row of parents.results as Row[]) {
    const id = Number(row.id); const list = parentMap.get(id) ?? []; list.push(String(row.external_id)); parentMap.set(id, list);
  }
  for (const row of children.results as Row[]) {
    const id = Number(row.id); const list = childMap.get(id) ?? []; list.push(String(row.external_id)); childMap.set(id, list);
  }
  for (const row of activated.results as Row[]) if (!activeMap.has(Number(row.id))) activeMap.set(Number(row.id), Number(row.inventory_item_id));
  return rows.map((row) => ({
    id: row.id,
    external_id: row.external_id,
    name: row.name,
    normalized_name: row.normalized_name ?? String(row.name).trim().toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim(),
    category: row.category,
    stage: row.stage,
    process: row.process,
    added_to_complete_lineage: Boolean(row.added_to_complete_lineage),
    source_correction: row.source_correction,
    resolution_needed: row.resolution_needed,
    catalog_schema_version: row.catalog_schema_version,
    parent_ids: parentMap.get(Number(row.id)) ?? [],
    child_ids: childMap.get(Number(row.id)) ?? [],
    activated_inventory_item_id: activeMap.get(Number(row.id)) ?? null,
  }));
}

async function listCatalog(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response> {
  const denied = await authenticated(request, bindings); if (denied !== null) return denied;
  const search = url.searchParams.get("search")?.trim().toLowerCase() ?? null;
  const category = url.searchParams.get("category");
  const stage = url.searchParams.get("stage");
  const confirm = url.searchParams.get("requires_confirmation");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const clauses = ["external_id IS NOT NULL", "active = 1"];
  const values: unknown[] = [];
  if (search !== null && search !== "") { clauses.push("(normalized_name LIKE ? OR external_id LIKE ?)"); values.push(`%${search.replace(/[^a-z0-9]+/gu, " ").trim()}%`, `%${search.replace(/\s+/gu, "_")}%`); }
  if (category) { clauses.push("category = ?"); values.push(category); }
  if (stage) { clauses.push("stage = ?"); values.push(stage); }
  if (confirm === "true") clauses.push("(resolution_needed IS NOT NULL OR stage = 'unresolved')");
  if (confirm === "false") clauses.push("NOT (resolution_needed IS NOT NULL OR stage = 'unresolved')");
  const where = clauses.join(" AND ");
  const [count, result] = await bindings.database.batch([
    bindings.database.prepare(`SELECT COUNT(*) AS total FROM ingredients WHERE ${where}`).bind(...values),
    bindings.database.prepare(`SELECT * FROM ingredients WHERE ${where} ORDER BY category, name LIMIT ? OFFSET ?`).bind(...values, limit, offset),
  ]);
  const items = await serialize(bindings.database, result.results as Row[]);
  return jsonResponse(request, { items, total: Number((count.results[0] as Row | undefined)?.total ?? 0), limit, offset });
}

async function metadata(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const denied = await authenticated(request, bindings); if (denied !== null) return denied;
  const latest = await bindings.database.prepare("SELECT * FROM ingredient_catalog_imports ORDER BY created_at DESC LIMIT 1").first<Row>();
  if (latest === null) return apiError(request, 404, "Ingredient catalog has not been imported");
  const [categories, stages] = await bindings.database.batch([
    bindings.database.prepare("SELECT DISTINCT category AS value FROM ingredients WHERE external_id IS NOT NULL AND category IS NOT NULL ORDER BY category"),
    bindings.database.prepare("SELECT DISTINCT stage AS value FROM ingredients WHERE external_id IS NOT NULL AND stage IS NOT NULL ORDER BY stage"),
  ]);
  let extra: Row = {}; try { extra = typeof latest.catalog_metadata === "string" ? JSON.parse(latest.catalog_metadata) as Row : (latest.catalog_metadata as Row ?? {}); } catch { extra = {}; }
  return jsonResponse(request, {
    schema_version: latest.schema_version, source_name: latest.source_name, source_sha256: latest.source_sha256,
    item_count: latest.item_count, relationship_count: latest.relationship_count,
    categories: (categories.results as Row[]).map((row) => row.value), stages: (stages.results as Row[]).map((row) => row.value), ...extra,
  });
}

async function one(request: Request, externalId: string, bindings: RuntimeBindings): Promise<Response> {
  const denied = await authenticated(request, bindings); if (denied !== null) return denied;
  const row = await bindings.database.prepare("SELECT * FROM ingredients WHERE external_id = ? AND active = 1").bind(decodeURIComponent(externalId)).first<Row>();
  if (row === null) return apiError(request, 404, "Catalog ingredient not found");
  return jsonResponse(request, (await serialize(bindings.database, [row]))[0]);
}

export async function routeIngredientCatalog(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (url.pathname === "/ingredient-catalog") return request.method === "GET" ? listCatalog(request, url, bindings) : methodNotAllowed(request, "GET");
  if (url.pathname === "/ingredient-catalog/metadata") return request.method === "GET" ? metadata(request, bindings) : methodNotAllowed(request, "GET");
  if(url.pathname==="/ingredient-catalog/import-default")return request.method==="POST"?importCatalog(request,bindings,defaultCatalog,"ingredient_catalog.json",url.searchParams.get("dry_run")==="true"):methodNotAllowed(request,"POST");
  if(url.pathname==="/ingredient-catalog/import-bar-inventory")return request.method==="POST"?importBar(request,url,bindings):methodNotAllowed(request,"POST");
  const match = /^\/ingredient-catalog\/([^/]+)$/u.exec(url.pathname);
  if (match !== null && !match[1].startsWith("import-")) return request.method === "GET" ? one(request, match[1], bindings) : methodNotAllowed(request, "GET");
  return null;
}
