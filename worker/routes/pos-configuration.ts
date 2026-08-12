import { apiError, jsonResponse, methodNotAllowed, validationError } from "../http";
import type { RuntimeBindings } from "../runtime";
import {
  booleanValue,
  constraintResponse,
  integerValue,
  iso,
  isObject,
  jsonArray,
  jsonBody,
  jsonObject,
  jsonText,
  nullableString,
  numberValue,
  randomId,
  recordPOSAudit,
  requireExisting,
  requireManager,
  requiredString,
  rowExists,
  slugIsValid,
  slugify,
  type AuthorizedUser,
  type JsonObject,
} from "./pos-common";

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

const POS_PERMISSIONS = [
  "pos.view", "pos.edit", "pos.create_button", "pos.delete_button", "pos.edit_layout",
  "pos.manage_modifiers", "pos.manage_tags", "pos.import_export", "pos.view_audit",
] as const;

async function rows(
  database: D1Database,
  sql: string,
  values: SqlValue[] = [],
): Promise<Row[]> {
  return (await database.prepare(sql).bind(...values).all<Row>()).results;
}

function assignment(value: unknown): { id: number; display_order: number; disabled: boolean; overrides: JsonObject } | null {
  if (!isObject(value)) return null;
  const id = integerValue(value.id);
  if (id < 1) return null;
  return {
    id,
    display_order: Math.max(0, integerValue(value.display_order)),
    disabled: booleanValue(value.disabled, false),
    overrides: jsonObject(value.overrides),
  };
}

function assignments(value: unknown): Array<ReturnType<typeof assignment> & object> {
  return Array.isArray(value)
    ? value.map(assignment).filter((entry): entry is NonNullable<ReturnType<typeof assignment>> => entry !== null)
    : [];
}

function pageSnapshot(row: Row): JsonObject {
  return {
    id: numberValue(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ?? null,
    active: booleanValue(row.active),
    display_order: numberValue(row.display_order),
    metadata: jsonObject(row.metadata),
  };
}

function modifierSnapshot(row: Row): JsonObject {
  return {
    id: numberValue(row.id),
    internal_key: String(row.internal_key),
    name: String(row.name),
    price_delta_cents: numberValue(row.price_delta_cents),
    default_selected: booleanValue(row.default_selected, false),
    active: booleanValue(row.active),
    display_order: numberValue(row.display_order),
    opens_modifier_group_id: row.opens_modifier_group_id === null ? null : numberValue(row.opens_modifier_group_id),
    conditional_visibility: jsonObject(row.conditional_visibility),
    metadata: jsonObject(row.metadata),
  };
}

function groupSnapshot(row: Row, modifiers: JsonObject[], override: JsonObject = {}): JsonObject {
  const result: JsonObject = {
    id: numberValue(row.id),
    slug: String(row.slug),
    name: String(row.name),
    prompt: row.prompt ?? null,
    required: booleanValue(row.required, false),
    minimum_selections: numberValue(row.minimum_selections),
    maximum_selections: numberValue(row.maximum_selections, 1),
    allow_quantities: booleanValue(row.allow_quantities, false),
    active: booleanValue(row.active),
    conditional_visibility: jsonObject(row.conditional_visibility),
    metadata: jsonObject(row.metadata),
    modifiers,
  };
  for (const key of ["prompt", "required", "minimum_selections", "maximum_selections", "allow_quantities", "conditional_visibility"]) {
    if (key in override) result[key] = override[key];
  }
  return result;
}

function promptSnapshot(row: Row, override: JsonObject = {}): JsonObject {
  const result: JsonObject = {
    id: numberValue(row.id),
    slug: String(row.slug),
    name: String(row.name),
    message: String(row.message),
    modifier_group_id: row.modifier_group_id === null ? null : numberValue(row.modifier_group_id),
    required: booleanValue(row.required, false),
    active: booleanValue(row.active),
    config: jsonObject(row.config),
  };
  for (const key of ["message", "required", "config"]) if (key in override) result[key] = override[key];
  return result;
}

function ruleSnapshot(row: Row): JsonObject {
  return {
    id: numberValue(row.id),
    name: String(row.name),
    scope_type: String(row.scope_type),
    scope_id: row.scope_id === null ? null : numberValue(row.scope_id),
    condition: jsonObject(row.condition),
    action: jsonObject(row.action),
    priority: numberValue(row.priority),
    active: booleanValue(row.active),
  };
}

export async function ensureLegacyPOSButtons(database: D1Database): Promise<void> {
  const [categories, existingPages] = await Promise.all([
    rows(database, "SELECT id,name,description,active,display_order FROM menu_categories ORDER BY display_order,id"),
    rows(database, "SELECT id,slug,name FROM pos_pages"),
  ]);
  const pagesBySlug = new Map(existingPages.map((row) => [String(row.slug), numberValue(row.id)]));
  const statements: D1PreparedStatement[] = [];
  for (const category of categories) {
    const slug = slugify(String(category.name));
    if (pagesBySlug.has(slug)) continue;
    const id = randomId();
    pagesBySlug.set(slug, id);
    statements.push(database.prepare(
      `INSERT INTO pos_pages(id,slug,name,description,active,display_order,metadata,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(id, slug, String(category.name), category.description ?? null, booleanValue(category.active) ? 1 : 0,
      numberValue(category.display_order), jsonText({ legacy_category_id: numberValue(category.id) })));
  }
  if (pagesBySlug.size === 0) {
    const id = randomId();
    pagesBySlug.set("menu", id);
    statements.push(database.prepare(
      `INSERT INTO pos_pages(id,slug,name,description,active,display_order,metadata,created_at,updated_at)
       VALUES(?,'menu','Menu',NULL,1,1,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(id));
  }
  if (statements.length > 0) await database.batch(statements);

  const items = await rows(database,
    `SELECT mi.id,mi.name,mi.category_id,mi.active,mc.name AS category_name
     FROM menu_items mi LEFT JOIN menu_categories mc ON mc.id=mi.category_id
     LEFT JOIN pos_buttons pb ON pb.menu_item_id=mi.id
     WHERE mi.active=1 AND pb.id IS NULL ORDER BY mi.id`,
  );
  if (items.length === 0) return;
  const counts = new Map<number, number>();
  for (const row of await rows(database, "SELECT page_id,COUNT(*) AS count FROM pos_buttons GROUP BY page_id")) {
    counts.set(numberValue(row.page_id), numberValue(row.count));
  }
  const defaultPageId = pagesBySlug.values().next().value as number;
  const keys = new Set((await rows(database, "SELECT internal_key FROM pos_buttons")).map((row) => String(row.internal_key)));
  const inserts: D1PreparedStatement[] = [];
  for (const item of items) {
    const pageId = pagesBySlug.get(slugify(String(item.category_name ?? "menu"))) ?? defaultPageId;
    const count = counts.get(pageId) ?? 0;
    counts.set(pageId, count + 1);
    let key = slugify(String(item.name));
    if (keys.has(key)) key = `${key}-${numberValue(item.id)}`;
    keys.add(key);
    inserts.push(database.prepare(
      `INSERT INTO pos_buttons
       (id,internal_key,menu_item_id,page_id,display_name,description,button_type,alternate_price_cents,
        weight_value,weight_unit,active,deleted_at,availability,visual,routing,metadata,grid_row,grid_column,
        grid_width,grid_height,display_order,revision,created_at,updated_at)
       VALUES(?,?,?,?,?,NULL,'PRODUCT',NULL,NULL,NULL,1,NULL,'{}',?,'{}','{}',?,?,1,1,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), key, numberValue(item.id), pageId, String(item.name),
      jsonText({ type: "text", background_color: "#dedede", text_color: "#111111" }),
      Math.floor(count / 4) + 1, (count % 4) + 1, count));
  }
  await database.batch(inserts);
}

export async function configurationBundle(
  database: D1Database,
  options: { includeDeleted?: boolean; resolve?: boolean } = {},
): Promise<JsonObject> {
  await ensureLegacyPOSButtons(database);
  const includeDeleted = options.includeDeleted ?? true;
  const [pageRows, buttonRows, tagRows, buttonTags, groupRows, modifierRows, buttonGroups, tagGroups,
    promptRows, buttonPrompts, tagPrompts, ruleRows, ingredientRows] = await Promise.all([
    rows(database, "SELECT * FROM pos_pages ORDER BY display_order,name"),
    rows(database,
      `SELECT b.*,mi.name AS menu_name,mi.category_id,mi.price_cents,mc.name AS category_name,p.slug AS page_slug
       FROM pos_buttons b JOIN menu_items mi ON mi.id=b.menu_item_id
       LEFT JOIN menu_categories mc ON mc.id=mi.category_id JOIN pos_pages p ON p.id=b.page_id
       ${includeDeleted ? "" : "WHERE b.deleted_at IS NULL AND b.active=1"}
       ORDER BY b.page_id,b.display_order,b.id`),
    rows(database, "SELECT * FROM pos_tags ORDER BY name"),
    rows(database, "SELECT bt.button_id,bt.tag_id,t.slug FROM pos_button_tags bt JOIN pos_tags t ON t.id=bt.tag_id ORDER BY bt.id"),
    rows(database, "SELECT * FROM pos_modifier_groups ORDER BY name"),
    rows(database, "SELECT * FROM pos_modifiers ORDER BY group_id,display_order,id"),
    rows(database, "SELECT * FROM pos_button_modifier_groups ORDER BY display_order,id"),
    rows(database, "SELECT * FROM pos_tag_modifier_groups ORDER BY display_order,id"),
    rows(database, "SELECT * FROM pos_prompts ORDER BY name"),
    rows(database, "SELECT * FROM pos_button_prompts ORDER BY display_order,id"),
    rows(database, "SELECT * FROM pos_tag_prompts ORDER BY display_order,id"),
    rows(database, "SELECT * FROM pos_behavior_rules ORDER BY priority,id"),
    rows(database,
      `SELECT ri.*,i.name FROM recipe_items ri JOIN ingredients i ON i.id=ri.ingredient_id
       ORDER BY ri.menu_item_id,ri.display_order,ri.id`),
  ]);

  const modifiersByGroup = new Map<number, JsonObject[]>();
  for (const row of modifierRows) {
    const key = numberValue(row.group_id);
    const values = modifiersByGroup.get(key) ?? [];
    values.push(modifierSnapshot(row));
    modifiersByGroup.set(key, values);
  }
  const groupsById = new Map<number, Row>();
  for (const row of groupRows) groupsById.set(numberValue(row.id), row);
  const promptsById = new Map<number, Row>();
  for (const row of promptRows) promptsById.set(numberValue(row.id), row);

  const tagsByButton = new Map<number, Row[]>();
  for (const row of buttonTags) {
    const key = numberValue(row.button_id);
    const values = tagsByButton.get(key) ?? [];
    values.push(row);
    tagsByButton.set(key, values);
  }
  const directGroups = new Map<number, Row[]>();
  for (const row of buttonGroups) {
    const key = numberValue(row.button_id);
    const values = directGroups.get(key) ?? [];
    values.push(row);
    directGroups.set(key, values);
  }
  const inheritedGroups = new Map<number, Row[]>();
  for (const row of tagGroups) {
    const key = numberValue(row.tag_id);
    const values = inheritedGroups.get(key) ?? [];
    values.push(row);
    inheritedGroups.set(key, values);
  }
  const directPrompts = new Map<number, Row[]>();
  for (const row of buttonPrompts) {
    const key = numberValue(row.button_id);
    const values = directPrompts.get(key) ?? [];
    values.push(row);
    directPrompts.set(key, values);
  }
  const inheritedPrompts = new Map<number, Row[]>();
  for (const row of tagPrompts) {
    const key = numberValue(row.tag_id);
    const values = inheritedPrompts.get(key) ?? [];
    values.push(row);
    inheritedPrompts.set(key, values);
  }
  const ingredientsByItem = new Map<number, JsonObject[]>();
  for (const row of ingredientRows) {
    const key = numberValue(row.menu_item_id);
    const values = ingredientsByItem.get(key) ?? [];
    values.push({
      ingredient_id: numberValue(row.ingredient_id), name: String(row.name), quantity: numberValue(row.quantity, 1),
      selection_type: String(row.selection_type ?? "INCLUDED"), display_order: numberValue(row.display_order),
    });
    ingredientsByItem.set(key, values);
  }

  const buttons = buttonRows.map((row) => {
    const id = numberValue(row.id);
    const tagLinks = tagsByButton.get(id) ?? [];
    const base: JsonObject = {
      id,
      internal_key: String(row.internal_key),
      menu_item_id: numberValue(row.menu_item_id),
      name: String(row.menu_name),
      display_name: String(row.display_name),
      description: row.description ?? null,
      category_id: row.category_id === null ? null : numberValue(row.category_id),
      category: row.category_name ?? null,
      page_id: numberValue(row.page_id),
      page: String(row.page_slug),
      price_cents: numberValue(row.price_cents),
      alternate_price_cents: row.alternate_price_cents === null ? null : numberValue(row.alternate_price_cents),
      weight_value: row.weight_value === null ? null : numberValue(row.weight_value),
      weight_unit: row.weight_unit ?? null,
      button_type: String(row.button_type ?? "PRODUCT"),
      active: booleanValue(row.active),
      deleted_at: iso(row.deleted_at === null ? null : String(row.deleted_at)),
      availability: jsonObject(row.availability), visual: jsonObject(row.visual), routing: jsonObject(row.routing),
      metadata: jsonObject(row.metadata),
      layout: { row: numberValue(row.grid_row, 1), column: numberValue(row.grid_column, 1), width: numberValue(row.grid_width, 1), height: numberValue(row.grid_height, 1), display_order: numberValue(row.display_order) },
      revision: numberValue(row.revision, 1),
      tag_ids: tagLinks.map((link) => numberValue(link.tag_id)),
      tags: tagLinks.map((link) => String(link.slug)),
      modifier_assignments: (directGroups.get(id) ?? []).map((link) => ({ id: numberValue(link.modifier_group_id), display_order: numberValue(link.display_order), disabled: booleanValue(link.disabled, false), overrides: jsonObject(link.override_config) })),
      prompt_assignments: (directPrompts.get(id) ?? []).map((link) => ({ id: numberValue(link.prompt_id), display_order: numberValue(link.display_order), disabled: booleanValue(link.disabled, false), overrides: jsonObject(link.override_config) })),
      ingredients: ingredientsByItem.get(numberValue(row.menu_item_id)) ?? [],
    };
    if (!(options.resolve ?? false)) return base;

    const resolvedGroups = new Map<number, { order: number; overrides: JsonObject; source: string }>();
    const resolvedPrompts = new Map<number, { order: number; overrides: JsonObject; source: string }>();
    for (const tagLink of tagLinks) {
      const tagId = numberValue(tagLink.tag_id);
      for (const link of inheritedGroups.get(tagId) ?? []) {
        const groupId = numberValue(link.modifier_group_id);
        if (!resolvedGroups.has(groupId)) resolvedGroups.set(groupId, { order: numberValue(link.display_order), overrides: jsonObject(link.override_config), source: `tag:${String(tagLink.slug)}` });
      }
      for (const link of inheritedPrompts.get(tagId) ?? []) {
        const promptId = numberValue(link.prompt_id);
        if (!resolvedPrompts.has(promptId)) resolvedPrompts.set(promptId, { order: numberValue(link.display_order), overrides: jsonObject(link.override_config), source: `tag:${String(tagLink.slug)}` });
      }
    }
    for (const link of directGroups.get(id) ?? []) {
      const groupId = numberValue(link.modifier_group_id);
      if (booleanValue(link.disabled, false)) resolvedGroups.delete(groupId);
      else resolvedGroups.set(groupId, { order: numberValue(link.display_order), overrides: jsonObject(link.override_config), source: "button" });
    }
    for (const link of directPrompts.get(id) ?? []) {
      const promptId = numberValue(link.prompt_id);
      if (booleanValue(link.disabled, false)) resolvedPrompts.delete(promptId);
      else resolvedPrompts.set(promptId, { order: numberValue(link.display_order), overrides: jsonObject(link.override_config), source: "button" });
    }
    base.modifier_groups = [...resolvedGroups.entries()].sort((a, b) => a[1].order - b[1].order || a[0] - b[0]).flatMap(([groupId, config]) => {
      const group = groupsById.get(groupId);
      if (group === undefined || !booleanValue(group.active)) return [];
      return [{ ...groupSnapshot(group, modifiersByGroup.get(groupId) ?? [], config.overrides), source: config.source }];
    });
    base.prompts = [...resolvedPrompts.entries()].sort((a, b) => a[1].order - b[1].order || a[0] - b[0]).flatMap(([promptId, config]) => {
      const prompt = promptsById.get(promptId);
      if (prompt === undefined || !booleanValue(prompt.active)) return [];
      return [{ ...promptSnapshot(prompt, config.overrides), source: config.source }];
    });
    const tagIds = new Set(tagLinks.map((link) => numberValue(link.tag_id)));
    base.rules = ruleRows.filter((rule) => booleanValue(rule.active) && (
      rule.scope_type === "GLOBAL" ||
      (rule.scope_type === "BUTTON" && numberValue(rule.scope_id) === id) ||
      (rule.scope_type === "TAG" && tagIds.has(numberValue(rule.scope_id)))
    )).map((rule) => ({ id: numberValue(rule.id), name: String(rule.name), condition: jsonObject(rule.condition), action: jsonObject(rule.action), priority: numberValue(rule.priority) }));
    return base;
  });

  return {
    schema_version: 1,
    pages: pageRows.map(pageSnapshot),
    buttons,
    tags: tagRows.map((tag) => ({
      id: numberValue(tag.id), slug: String(tag.slug), name: String(tag.name), description: tag.description ?? null,
      color: tag.color ?? null, active: booleanValue(tag.active), behavior: jsonObject(tag.behavior),
      modifier_groups: (inheritedGroups.get(numberValue(tag.id)) ?? []).map((link) => ({ id: numberValue(link.modifier_group_id), display_order: numberValue(link.display_order), overrides: jsonObject(link.override_config) })),
      prompts: (inheritedPrompts.get(numberValue(tag.id)) ?? []).map((link) => ({ id: numberValue(link.prompt_id), display_order: numberValue(link.display_order), overrides: jsonObject(link.override_config) })),
    })),
    modifier_groups: groupRows.map((group) => groupSnapshot(group, modifiersByGroup.get(numberValue(group.id)) ?? [])),
    prompts: promptRows.map((prompt) => promptSnapshot(prompt)),
    rules: ruleRows.map(ruleSnapshot),
  };
}

async function auditRows(database: D1Database, limit: number): Promise<JsonObject[]> {
  return (await rows(database,
    `SELECT a.*,u.full_name AS actor_name FROM pos_config_audit a JOIN users u ON u.id=a.actor_user_id
     ORDER BY a.created_at DESC LIMIT ?`, [limit])).map((row) => ({
    id: numberValue(row.id), actor_user_id: numberValue(row.actor_user_id), actor_name: String(row.actor_name),
    action: String(row.action), entity_type: String(row.entity_type), entity_id: row.entity_id === null ? null : numberValue(row.entity_id),
    before: row.before_value === null ? null : jsonObject(row.before_value), after: row.after_value === null ? null : jsonObject(row.after_value),
    created_at: iso(String(row.created_at)),
  }));
}

async function resolvedButton(database: D1Database, id: number): Promise<JsonObject | null> {
  const bundle = await configurationBundle(database, { includeDeleted: false, resolve: true });
  return (bundle.buttons as JsonObject[]).find((button) => numberValue(button.id) === id) ?? null;
}

function validSlugPayload(request: Request, body: JsonObject, maxName = 100): { slug: string; name: string } | Response {
  const slug = requiredString(request, body, "slug", 100);
  if (slug instanceof Response) return slug;
  const name = requiredString(request, body, "name", maxName);
  if (name instanceof Response) return name;
  if (!slugIsValid(slug)) return validationError(request, [{ type: "string_pattern_mismatch", loc: ["body", "slug"], msg: "String should match pattern", input: slug }]);
  return { slug, name };
}

async function createPage(request: Request, body: JsonObject, bindings: RuntimeBindings, user: AuthorizedUser): Promise<Response> {
  const core = validSlugPayload(request, body);
  if (core instanceof Response) return core;
  const id = randomId();
  const snapshot: JsonObject = {
    id, ...core, description: nullableString(body.description), active: booleanValue(body.active),
    display_order: Math.max(0, integerValue(body.display_order)), metadata: jsonObject(body.metadata),
  };
  try {
    await bindings.database.batch([
      bindings.database.prepare(
        `INSERT INTO pos_pages(id,slug,name,description,active,display_order,metadata,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      ).bind(id, core.slug, core.name, snapshot.description, snapshot.active ? 1 : 0, snapshot.display_order, jsonText(snapshot.metadata)),
      bindings.database.prepare(
        `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
         VALUES(?,?,'PAGE_CREATED','PAGE',?,NULL,?,CURRENT_TIMESTAMP)`,
      ).bind(randomId(), user.id, id, jsonText(snapshot)),
    ]);
    return jsonResponse(request, snapshot, { status: 201 });
  } catch (error) {
    return constraintResponse(request, error) ?? apiError(request, 500, "Internal Server Error");
  }
}

async function updatePage(request: Request, pageId: number, body: JsonObject, bindings: RuntimeBindings, user: AuthorizedUser): Promise<Response> {
  const existing = await bindings.database.prepare("SELECT * FROM pos_pages WHERE id=?").bind(pageId).first<Row>();
  if (existing === null) return apiError(request, 404, "POS page not found");
  const core = validSlugPayload(request, body);
  if (core instanceof Response) return core;
  const before = pageSnapshot(existing);
  const after: JsonObject = {
    id: pageId, ...core, description: nullableString(body.description), active: booleanValue(body.active),
    display_order: Math.max(0, integerValue(body.display_order)), metadata: jsonObject(body.metadata),
  };
  try {
    await bindings.database.batch([
      bindings.database.prepare(
        `UPDATE pos_pages SET slug=?,name=?,description=?,active=?,display_order=?,metadata=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      ).bind(core.slug, core.name, after.description, after.active ? 1 : 0, after.display_order, jsonText(after.metadata), pageId),
      bindings.database.prepare(
        `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
         VALUES(?,?,'PAGE_CHANGED','PAGE',?,?,?,CURRENT_TIMESTAMP)`,
      ).bind(randomId(), user.id, pageId, jsonText(before), jsonText(after)),
    ]);
    return jsonResponse(request, after);
  } catch (error) {
    return constraintResponse(request, error) ?? apiError(request, 500, "Internal Server Error");
  }
}

async function disablePage(request: Request, pageId: number, bindings: RuntimeBindings, user: AuthorizedUser): Promise<Response> {
  const existing = await bindings.database.prepare("SELECT * FROM pos_pages WHERE id=?").bind(pageId).first<Row>();
  if (existing === null) return apiError(request, 404, "POS page not found");
  const active = await bindings.database.prepare("SELECT COUNT(*) AS count FROM pos_pages WHERE active=1 AND id<>?").bind(pageId).first<{ count: number }>();
  if (numberValue(active?.count) === 0) return apiError(request, 409, "At least one active POS page is required");
  const before = pageSnapshot(existing);
  const after = { ...before, active: false };
  await bindings.database.batch([
    bindings.database.prepare("UPDATE pos_pages SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(pageId),
    bindings.database.prepare(
      `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
       VALUES(?,?,'PAGE_DISABLED','PAGE',?,?,?,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), user.id, pageId, jsonText(before), jsonText(after)),
  ]);
  return jsonResponse(request, after);
}

interface ButtonPayload {
  internalKey: string;
  name: string;
  displayName: string;
  menuItemId: number | null;
  categoryId: number | null;
  pageId: number;
  priceCents: number;
  active: boolean;
  body: JsonObject;
}

function parseButton(request: Request, body: JsonObject): ButtonPayload | Response {
  const internalKey = requiredString(request, body, "internal_key", 120);
  if (internalKey instanceof Response) return internalKey;
  if (!slugIsValid(internalKey)) return validationError(request, [{ type: "string_pattern_mismatch", loc: ["body", "internal_key"], msg: "String should match pattern", input: internalKey }]);
  const name = requiredString(request, body, "name", 150);
  if (name instanceof Response) return name;
  const displayName = requiredString(request, body, "display_name", 100);
  if (displayName instanceof Response) return displayName;
  const pageId = integerValue(body.page_id);
  if (pageId < 1) return validationError(request, [{ type: "greater_than", loc: ["body", "page_id"], msg: "Input should be greater than 0", input: body.page_id }]);
  return {
    internalKey, name, displayName, pageId,
    menuItemId: body.menu_item_id === null || body.menu_item_id === undefined ? null : integerValue(body.menu_item_id),
    categoryId: body.category_id === null || body.category_id === undefined ? null : integerValue(body.category_id),
    priceCents: Math.max(0, integerValue(body.price_cents)), active: booleanValue(body.active), body,
  };
}

async function validateButtonReferences(request: Request, database: D1Database, payload: ButtonPayload): Promise<Response | null> {
  const missingPage = await requireExisting(request, database, "pos_pages", payload.pageId, "POS page");
  if (missingPage !== null) return missingPage;
  if (payload.categoryId !== null) {
    const missingCategory = await requireExisting(request, database, "menu_categories", payload.categoryId, "Menu category");
    if (missingCategory !== null) return missingCategory;
  }
  const tagIds = (Array.isArray(payload.body.tag_ids) ? payload.body.tag_ids : []).map(integerValue).filter((id) => id > 0);
  for (const tagId of tagIds) if (!(await rowExists(database, "pos_tags", tagId))) return apiError(request, 422, `Unknown tag: ${tagId}`);
  for (const value of assignments(payload.body.modifier_groups)) if (!(await rowExists(database, "pos_modifier_groups", value.id))) return apiError(request, 422, `Unknown modifier group: ${value.id}`);
  for (const value of assignments(payload.body.prompts)) if (!(await rowExists(database, "pos_prompts", value.id))) return apiError(request, 422, `Unknown prompt: ${value.id}`);
  for (const value of Array.isArray(payload.body.ingredients) ? payload.body.ingredients : []) {
    if (!isObject(value)) continue;
    const ingredientId = integerValue(value.ingredient_id);
    if (!(await rowExists(database, "ingredients", ingredientId))) return apiError(request, 422, `Unknown ingredient: ${ingredientId}`);
  }
  return null;
}

function buttonAssignmentStatements(database: D1Database, buttonId: number, menuItemId: number, body: JsonObject): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    database.prepare("DELETE FROM pos_button_tags WHERE button_id=?").bind(buttonId),
    database.prepare("DELETE FROM pos_button_modifier_groups WHERE button_id=?").bind(buttonId),
    database.prepare("DELETE FROM pos_button_prompts WHERE button_id=?").bind(buttonId),
    database.prepare("DELETE FROM recipe_items WHERE menu_item_id=?").bind(menuItemId),
  ];
  const tagIds = new Set((Array.isArray(body.tag_ids) ? body.tag_ids : []).map(integerValue).filter((id) => id > 0));
  for (const tagId of tagIds) statements.push(database.prepare("INSERT INTO pos_button_tags(id,button_id,tag_id) VALUES(?,?,?)").bind(randomId(), buttonId, tagId));
  for (const value of assignments(body.modifier_groups)) statements.push(database.prepare(
    "INSERT INTO pos_button_modifier_groups(id,button_id,modifier_group_id,display_order,disabled,override_config) VALUES(?,?,?,?,?,?)",
  ).bind(randomId(), buttonId, value.id, value.display_order, value.disabled ? 1 : 0, jsonText(value.overrides)));
  for (const value of assignments(body.prompts)) statements.push(database.prepare(
    "INSERT INTO pos_button_prompts(id,button_id,prompt_id,display_order,disabled,override_config) VALUES(?,?,?,?,?,?)",
  ).bind(randomId(), buttonId, value.id, value.display_order, value.disabled ? 1 : 0, jsonText(value.overrides)));
  for (const value of Array.isArray(body.ingredients) ? body.ingredients : []) {
    if (!isObject(value)) continue;
    statements.push(database.prepare(
      `INSERT INTO recipe_items(id,menu_item_id,ingredient_id,quantity,selection_type,display_order) VALUES(?,?,?,?,?,?)`,
    ).bind(randomId(), menuItemId, integerValue(value.ingredient_id), Math.max(0.000001, numberValue(value.quantity, 1)),
      String(value.selection_type ?? "INCLUDED"), Math.max(0, integerValue(value.display_order))));
  }
  return statements;
}

function buttonColumns(payload: ButtonPayload): SqlValue[] {
  const body = payload.body;
  return [
    payload.internalKey, payload.pageId, payload.displayName, nullableString(body.description), String(body.button_type ?? "PRODUCT"),
    body.alternate_price_cents === null || body.alternate_price_cents === undefined ? null : Math.max(0, integerValue(body.alternate_price_cents)),
    body.weight_value === null || body.weight_value === undefined ? null : numberValue(body.weight_value), nullableString(body.weight_unit),
    payload.active ? 1 : 0, jsonText(jsonObject(body.availability)), jsonText(jsonObject(body.visual)), jsonText(jsonObject(body.routing)),
    jsonText(jsonObject(body.metadata)), Math.max(1, integerValue(body.grid_row, 1)), Math.max(1, integerValue(body.grid_column, 1)),
    Math.max(1, integerValue(body.grid_width, 1)), Math.max(1, integerValue(body.grid_height, 1)), Math.max(0, integerValue(body.display_order)),
  ];
}

async function createButton(request: Request, body: JsonObject, bindings: RuntimeBindings, user: AuthorizedUser): Promise<Response> {
  const payload = parseButton(request, body);
  if (payload instanceof Response) return payload;
  const invalid = await validateButtonReferences(request, bindings.database, payload);
  if (invalid !== null) return invalid;
  let menuItemId = payload.menuItemId;
  if (menuItemId !== null) {
    if (!(await rowExists(bindings.database, "menu_items", menuItemId))) return apiError(request, 404, "Menu item not found");
    if ((await bindings.database.prepare("SELECT id FROM pos_buttons WHERE menu_item_id=?").bind(menuItemId).first()) !== null) return apiError(request, 409, "That menu item already has a POS button");
  } else menuItemId = randomId();
  const buttonId = randomId();
  const statements: D1PreparedStatement[] = [];
  if (payload.menuItemId === null) statements.push(bindings.database.prepare(
    "INSERT INTO menu_items(id,category_id,name,price_cents,active) VALUES(?,?,?,?,?)",
  ).bind(menuItemId, payload.categoryId, payload.name, payload.priceCents, payload.active ? 1 : 0));
  else statements.push(bindings.database.prepare(
    "UPDATE menu_items SET category_id=?,name=?,price_cents=?,active=? WHERE id=?",
  ).bind(payload.categoryId, payload.name, payload.priceCents, payload.active ? 1 : 0, menuItemId));
  statements.push(bindings.database.prepare(
    `INSERT INTO pos_buttons(id,internal_key,menu_item_id,page_id,display_name,description,button_type,alternate_price_cents,
      weight_value,weight_unit,active,deleted_at,availability,visual,routing,metadata,grid_row,grid_column,grid_width,grid_height,
      display_order,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?, ?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  ).bind(buttonId, payload.internalKey, menuItemId, ...buttonColumns(payload).slice(1)));
  statements.push(...buttonAssignmentStatements(bindings.database, buttonId, menuItemId, body));
  statements.push(bindings.database.prepare(
    `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
     VALUES(?,?,'BUTTON_CREATED','BUTTON',?,NULL,?,CURRENT_TIMESTAMP)`,
  ).bind(randomId(), user.id, buttonId, jsonText({ id: buttonId, internal_key: payload.internalKey, display_name: payload.displayName })));
  try {
    await bindings.database.batch(statements);
  } catch (error) {
    console.error(JSON.stringify({ message: "POS button create failed", error: error instanceof Error ? error.message : String(error) }));
    return constraintResponse(request, error) ?? apiError(request, 500, "Internal Server Error");
  }
  const result = await resolvedButton(bindings.database, buttonId);
  return result === null ? apiError(request, 500, "Internal Server Error") : jsonResponse(request, result, { status: 201 });
}

async function updateButton(request: Request, buttonId: number, body: JsonObject, bindings: RuntimeBindings, user: AuthorizedUser): Promise<Response> {
  const current = await resolvedButton(bindings.database, buttonId);
  if (current === null) return apiError(request, 404, "POS button not found");
  const payload = parseButton(request, body);
  if (payload instanceof Response) return payload;
  const invalid = await validateButtonReferences(request, bindings.database, payload);
  if (invalid !== null) return invalid;
  const menuItemId = integerValue(current.menu_item_id);
  const statements: D1PreparedStatement[] = [
    bindings.database.prepare("UPDATE menu_items SET category_id=?,name=?,price_cents=?,active=? WHERE id=?")
      .bind(payload.categoryId, payload.name, payload.priceCents, payload.active ? 1 : 0, menuItemId),
    bindings.database.prepare(
      `UPDATE pos_buttons SET internal_key=?,page_id=?,display_name=?,description=?,button_type=?,alternate_price_cents=?,
       weight_value=?,weight_unit=?,active=?,availability=?,visual=?,routing=?,metadata=?,grid_row=?,grid_column=?,grid_width=?,
       grid_height=?,display_order=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(...buttonColumns(payload), buttonId),
    ...buttonAssignmentStatements(bindings.database, buttonId, menuItemId, body),
  ];
  const oldLayout = jsonObject(current.layout);
  const moved = integerValue(current.page_id) !== payload.pageId ||
    integerValue(oldLayout.row) !== integerValue(body.grid_row, 1) || integerValue(oldLayout.column) !== integerValue(body.grid_column, 1) ||
    integerValue(oldLayout.width) !== integerValue(body.grid_width, 1) || integerValue(oldLayout.height) !== integerValue(body.grid_height, 1);
  statements.push(bindings.database.prepare(
    `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
     VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
  ).bind(randomId(), user.id, moved ? "BUTTON_MOVED" : "BUTTON_CHANGED", "BUTTON", buttonId, jsonText(current),
    jsonText({ id: buttonId, internal_key: payload.internalKey, display_name: payload.displayName, revision: integerValue(current.revision) + 1 })));
  try {
    await bindings.database.batch(statements);
  } catch (error) {
    return constraintResponse(request, error) ?? apiError(request, 500, "Internal Server Error");
  }
  const result = await resolvedButton(bindings.database, buttonId);
  return result === null ? apiError(request, 500, "Internal Server Error") : jsonResponse(request, result);
}

async function duplicateButton(request: Request, buttonId: number, bindings: RuntimeBindings, user: AuthorizedUser): Promise<Response> {
  const source = await resolvedButton(bindings.database, buttonId);
  if (source === null) return apiError(request, 404, "POS button not found");
  const existing = new Set((await rows(bindings.database, "SELECT internal_key FROM pos_buttons")).map((row) => String(row.internal_key)));
  const root = `${String(source.internal_key)}-copy`;
  let key = root;
  for (let index = 2; existing.has(key); index += 1) key = `${root}-${index}`;
  const layout = jsonObject(source.layout);
  const body: JsonObject = {
    internal_key: key, name: `${String(source.name)} Copy`, display_name: `${String(source.display_name)} Copy`.slice(0, 100),
    description: source.description, category_id: source.category_id, page_id: source.page_id, price_cents: source.price_cents,
    alternate_price_cents: source.alternate_price_cents, weight_value: source.weight_value, weight_unit: source.weight_unit,
    button_type: source.button_type, active: source.active, availability: source.availability, visual: source.visual,
    routing: source.routing, metadata: source.metadata, grid_row: layout.row, grid_column: layout.column,
    grid_width: layout.width, grid_height: layout.height, display_order: integerValue(layout.display_order) + 1,
    tag_ids: source.tag_ids, modifier_groups: source.modifier_assignments, prompts: source.prompt_assignments,
    ingredients: source.ingredients,
  };
  return createButton(request, body, bindings, user);
}

async function setButtonDeleted(request: Request, buttonId: number, restore: boolean, bindings: RuntimeBindings, user: AuthorizedUser): Promise<Response> {
  const row = await bindings.database.prepare("SELECT id,menu_item_id,active,deleted_at,revision FROM pos_buttons WHERE id=?").bind(buttonId).first<Row>();
  if (row === null) return apiError(request, 404, "POS button not found");
  const before = { active: booleanValue(row.active), deleted_at: iso(row.deleted_at === null ? null : String(row.deleted_at)), revision: numberValue(row.revision) };
  const after = { active: restore, deleted_at: restore ? null : new Date().toISOString(), revision: numberValue(row.revision) + 1 };
  const statements = [
    bindings.database.prepare(
      `UPDATE pos_buttons SET active=?,deleted_at=${restore ? "NULL" : "CURRENT_TIMESTAMP"},revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(restore ? 1 : 0, buttonId),
    bindings.database.prepare(
      `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
       VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), user.id, restore ? "BUTTON_RESTORED" : "BUTTON_DELETED", "BUTTON", buttonId, jsonText(before), jsonText(after)),
  ];
  if (restore) statements.splice(1, 0, bindings.database.prepare("UPDATE menu_items SET active=1 WHERE id=?").bind(numberValue(row.menu_item_id)));
  await bindings.database.batch(statements);
  if (!restore) return jsonResponse(request, after);
  const result = await resolvedButton(bindings.database, buttonId);
  return result === null ? apiError(request, 500, "Internal Server Error") : jsonResponse(request, result);
}

async function updateLayout(request: Request, body: JsonObject, bindings: RuntimeBindings, user: AuthorizedUser): Promise<Response> {
  if (!Array.isArray(body.entries) || body.entries.length === 0) return validationError(request, [{ type: "too_short", loc: ["body", "entries"], msg: "List should have at least 1 item", input: body.entries }]);
  const statements: D1PreparedStatement[] = [];
  const revisions: Record<string, number> = {};
  for (const value of body.entries) {
    if (!isObject(value)) return validationError(request, [{ type: "model_attributes_type", loc: ["body", "entries"], msg: "Input should be an object", input: value }]);
    const buttonId = integerValue(value.button_id), pageId = integerValue(value.page_id), revision = integerValue(value.revision);
    const row = await bindings.database.prepare("SELECT * FROM pos_buttons WHERE id=?").bind(buttonId).first<Row>();
    if (row === null) return apiError(request, 404, "One or more POS buttons were not found");
    if (!(await rowExists(bindings.database, "pos_pages", pageId))) return apiError(request, 422, `Unknown page: ${pageId}`);
    if (numberValue(row.revision) !== revision) return apiError(request, 409, `Button ${buttonId} was changed by another editor`);
    const after = { page_id: pageId, row: Math.max(1, integerValue(value.grid_row, 1)), column: Math.max(1, integerValue(value.grid_column, 1)), width: Math.max(1, integerValue(value.grid_width, 1)), height: Math.max(1, integerValue(value.grid_height, 1)), revision: revision + 1 };
    statements.push(bindings.database.prepare(
      `UPDATE pos_buttons SET page_id=?,grid_row=?,grid_column=?,grid_width=?,grid_height=?,display_order=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=?`,
    ).bind(pageId, after.row, after.column, after.width, after.height, Math.max(0, integerValue(value.display_order)), buttonId, revision));
    statements.push(bindings.database.prepare(
      `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
       VALUES(?,?,'BUTTON_MOVED','BUTTON',?,?,?,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), user.id, buttonId, jsonText({ page_id: row.page_id, row: row.grid_row, column: row.grid_column, width: row.grid_width, height: row.grid_height }), jsonText(after)));
    revisions[String(buttonId)] = revision + 1;
  }
  await bindings.database.batch(statements);
  return jsonResponse(request, { updated: Object.keys(revisions).length, revisions });
}

async function writeTag(
  request: Request,
  body: JsonObject,
  bindings: RuntimeBindings,
  user: AuthorizedUser,
  tagId: number | null,
): Promise<Response> {
  const core = validSlugPayload(request, body);
  if (core instanceof Response) return core;
  const groups = assignments(body.modifier_groups);
  const prompts = assignments(body.prompts);
  for (const value of groups) if (!(await rowExists(bindings.database, "pos_modifier_groups", value.id))) return apiError(request, 422, `Unknown modifier group: ${value.id}`);
  for (const value of prompts) if (!(await rowExists(bindings.database, "pos_prompts", value.id))) return apiError(request, 422, `Unknown prompt: ${value.id}`);
  const current = tagId === null ? null : await bindings.database.prepare("SELECT * FROM pos_tags WHERE id=?").bind(tagId).first<Row>();
  if (tagId !== null && current === null) return apiError(request, 404, "POS tag not found");
  const id = tagId ?? randomId();
  const statements: D1PreparedStatement[] = [];
  if (current === null) statements.push(bindings.database.prepare(
    `INSERT INTO pos_tags(id,slug,name,description,color,active,behavior,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  ).bind(id, core.slug, core.name, nullableString(body.description), nullableString(body.color), booleanValue(body.active) ? 1 : 0, jsonText(jsonObject(body.behavior))));
  else statements.push(bindings.database.prepare(
    `UPDATE pos_tags SET slug=?,name=?,description=?,color=?,active=?,behavior=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).bind(core.slug, core.name, nullableString(body.description), nullableString(body.color), booleanValue(body.active) ? 1 : 0, jsonText(jsonObject(body.behavior)), id));
  statements.push(bindings.database.prepare("DELETE FROM pos_tag_modifier_groups WHERE tag_id=?").bind(id));
  statements.push(bindings.database.prepare("DELETE FROM pos_tag_prompts WHERE tag_id=?").bind(id));
  for (const value of groups) statements.push(bindings.database.prepare(
    "INSERT INTO pos_tag_modifier_groups(id,tag_id,modifier_group_id,display_order,override_config) VALUES(?,?,?,?,?)",
  ).bind(randomId(), id, value.id, value.display_order, jsonText(value.overrides)));
  for (const value of prompts) statements.push(bindings.database.prepare(
    "INSERT INTO pos_tag_prompts(id,tag_id,prompt_id,display_order,override_config) VALUES(?,?,?,?,?)",
  ).bind(randomId(), id, value.id, value.display_order, jsonText(value.overrides)));
  statements.push(bindings.database.prepare(
    `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
     VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
  ).bind(randomId(), user.id, current === null ? "TAG_CREATED" : "TAG_CHANGED", "TAG", id,
    current === null ? null : jsonText({ slug: current.slug, name: current.name, active: booleanValue(current.active), behavior: jsonObject(current.behavior) }),
    jsonText({ slug: core.slug, name: core.name, active: booleanValue(body.active), behavior: jsonObject(body.behavior) })));
  try {
    await bindings.database.batch(statements);
  } catch (error) {
    return constraintResponse(request, error) ?? apiError(request, 500, "Internal Server Error");
  }
  const bundle = await configurationBundle(bindings.database);
  return jsonResponse(request, bundle.tags, { status: current === null ? 201 : 200 });
}

async function disableSimple(
  request: Request,
  bindings: RuntimeBindings,
  user: AuthorizedUser,
  table: "pos_tags" | "pos_modifier_groups" | "pos_behavior_rules",
  id: number,
): Promise<Response> {
  const labels = {
    pos_tags: ["POS tag", "TAG", "TAG_DISABLED"],
    pos_modifier_groups: ["Modifier group", "MODIFIER_GROUP", "MODIFIER_GROUP_DISABLED"],
    pos_behavior_rules: ["Behavior rule", "RULE", "RULE_DISABLED"],
  } as const;
  const row = await bindings.database.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first<Row>();
  if (row === null) return apiError(request, 404, `${labels[table][0]} not found`);
  await bindings.database.batch([
    bindings.database.prepare(`UPDATE ${table} SET active=0${table === "pos_behavior_rules" || table === "pos_modifier_groups" ? ",updated_at=CURRENT_TIMESTAMP" : ""} WHERE id=?`).bind(id),
    bindings.database.prepare(
      `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
       VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), user.id, labels[table][2], labels[table][1], id, jsonText({ active: booleanValue(row.active) }), jsonText({ active: false })),
  ]);
  if (table === "pos_behavior_rules") return jsonResponse(request, { ...ruleSnapshot(row), active: false });
  return jsonResponse(request, { id, active: false });
}

async function writeModifierGroup(
  request: Request,
  body: JsonObject,
  bindings: RuntimeBindings,
  user: AuthorizedUser,
  groupId: number | null,
): Promise<Response> {
  const core = validSlugPayload(request, body, 120);
  if (core instanceof Response) return core;
  let minimum = Math.max(0, integerValue(body.minimum_selections));
  const required = booleanValue(body.required, false);
  if (required && minimum === 0) minimum = 1;
  const maximum = Math.max(1, integerValue(body.maximum_selections, 1));
  if (minimum > maximum) return validationError(request, [{ type: "value_error", loc: ["body"], msg: "Value error, minimum_selections cannot exceed maximum_selections", input: body }]);
  const current = groupId === null ? null : await bindings.database.prepare("SELECT * FROM pos_modifier_groups WHERE id=?").bind(groupId).first<Row>();
  if (groupId !== null && current === null) return apiError(request, 404, "Modifier group not found");
  const id = groupId ?? randomId();
  const statements: D1PreparedStatement[] = [];
  const values: SqlValue[] = [core.slug, core.name, nullableString(body.prompt), required ? 1 : 0, minimum, maximum,
    booleanValue(body.allow_quantities, false) ? 1 : 0, booleanValue(body.active) ? 1 : 0,
    jsonText(jsonObject(body.conditional_visibility)), jsonText(jsonObject(body.metadata))];
  if (current === null) statements.push(bindings.database.prepare(
    `INSERT INTO pos_modifier_groups(id,slug,name,prompt,required,minimum_selections,maximum_selections,allow_quantities,
     active,conditional_visibility,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  ).bind(id, ...values));
  else statements.push(bindings.database.prepare(
    `UPDATE pos_modifier_groups SET slug=?,name=?,prompt=?,required=?,minimum_selections=?,maximum_selections=?,
     allow_quantities=?,active=?,conditional_visibility=?,metadata=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).bind(...values, id));
  statements.push(bindings.database.prepare("DELETE FROM pos_modifiers WHERE group_id=?").bind(id));
  for (const value of Array.isArray(body.modifiers) ? body.modifiers : []) {
    if (!isObject(value)) continue;
    const internalKey = typeof value.internal_key === "string" ? value.internal_key.trim() : "";
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!slugIsValid(internalKey) || name.length === 0) return validationError(request, [{ type: "value_error", loc: ["body", "modifiers"], msg: "Modifier key and name are required", input: value }]);
    const opens = value.opens_modifier_group_id === null || value.opens_modifier_group_id === undefined ? null : integerValue(value.opens_modifier_group_id);
    if (opens !== null && !(await rowExists(bindings.database, "pos_modifier_groups", opens)) && opens !== id) return apiError(request, 422, `Unknown modifier group: ${opens}`);
    statements.push(bindings.database.prepare(
      `INSERT INTO pos_modifiers(id,group_id,internal_key,name,price_delta_cents,default_selected,active,display_order,
       opens_modifier_group_id,conditional_visibility,metadata,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), id, internalKey, name, integerValue(value.price_delta_cents), booleanValue(value.default_selected, false) ? 1 : 0,
      booleanValue(value.active) ? 1 : 0, Math.max(0, integerValue(value.display_order)), opens,
      jsonText(jsonObject(value.conditional_visibility)), jsonText(jsonObject(value.metadata))));
  }
  statements.push(bindings.database.prepare(
    `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
     VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
  ).bind(randomId(), user.id, current === null ? "MODIFIER_GROUP_CREATED" : "MODIFIER_GROUP_CHANGED", "MODIFIER_GROUP", id,
    current === null ? null : jsonText({ slug: current.slug, name: current.name, active: booleanValue(current.active) }),
    jsonText({ slug: core.slug, name: core.name, active: booleanValue(body.active) })));
  try {
    await bindings.database.batch(statements);
  } catch (error) {
    return constraintResponse(request, error) ?? apiError(request, 500, "Internal Server Error");
  }
  const bundle = await configurationBundle(bindings.database);
  const result = (bundle.modifier_groups as JsonObject[]).find((value) => numberValue(value.id) === id);
  return jsonResponse(request, result, { status: current === null ? 201 : 200 });
}

async function writePrompt(
  request: Request,
  body: JsonObject,
  bindings: RuntimeBindings,
  user: AuthorizedUser,
  promptId: number | null,
): Promise<Response> {
  const core = validSlugPayload(request, body, 120);
  if (core instanceof Response) return core;
  const message = requiredString(request, body, "message", 240);
  if (message instanceof Response) return message;
  const groupId = body.modifier_group_id === null || body.modifier_group_id === undefined ? null : integerValue(body.modifier_group_id);
  if (groupId !== null && !(await rowExists(bindings.database, "pos_modifier_groups", groupId))) return apiError(request, 404, "Modifier group not found");
  const current = promptId === null ? null : await bindings.database.prepare("SELECT * FROM pos_prompts WHERE id=?").bind(promptId).first<Row>();
  if (promptId !== null && current === null) return apiError(request, 404, "Prompt not found");
  const id = promptId ?? randomId();
  const statement = current === null
    ? bindings.database.prepare(
      `INSERT INTO pos_prompts(id,slug,name,message,modifier_group_id,required,active,config,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(id, core.slug, core.name, message, groupId, booleanValue(body.required, false) ? 1 : 0, booleanValue(body.active) ? 1 : 0, jsonText(jsonObject(body.config)))
    : bindings.database.prepare(
      `UPDATE pos_prompts SET slug=?,name=?,message=?,modifier_group_id=?,required=?,active=?,config=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(core.slug, core.name, message, groupId, booleanValue(body.required, false) ? 1 : 0, booleanValue(body.active) ? 1 : 0, jsonText(jsonObject(body.config)), id);
  try {
    await bindings.database.batch([
      statement,
      bindings.database.prepare(
        `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
         VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      ).bind(randomId(), user.id, current === null ? "PROMPT_CREATED" : "PROMPT_CHANGED", "PROMPT", id,
        current === null ? null : jsonText({ slug: current.slug, name: current.name, active: booleanValue(current.active) }),
        jsonText({ slug: core.slug, name: core.name, active: booleanValue(body.active) })),
    ]);
  } catch (error) {
    return constraintResponse(request, error) ?? apiError(request, 500, "Internal Server Error");
  }
  const bundle = await configurationBundle(bindings.database);
  const result = (bundle.prompts as JsonObject[]).find((value) => numberValue(value.id) === id);
  return jsonResponse(request, result, { status: current === null ? 201 : 200 });
}

async function writeRule(
  request: Request,
  body: JsonObject,
  bindings: RuntimeBindings,
  user: AuthorizedUser,
  ruleId: number | null,
): Promise<Response> {
  const name = requiredString(request, body, "name", 150);
  if (name instanceof Response) return name;
  const scopeType = String(body.scope_type ?? "GLOBAL");
  if (!new Set(["GLOBAL", "BUTTON", "TAG"]).has(scopeType)) return validationError(request, [{ type: "enum", loc: ["body", "scope_type"], msg: "Input should be 'GLOBAL', 'BUTTON' or 'TAG'", input: scopeType }]);
  const scopeId = body.scope_id === null || body.scope_id === undefined ? null : integerValue(body.scope_id);
  if ((scopeType === "GLOBAL" && scopeId !== null) || (scopeType !== "GLOBAL" && scopeId === null)) return validationError(request, [{ type: "value_error", loc: ["body"], msg: "Value error, invalid behavior rule scope", input: body }]);
  if (!isObject(body.condition) || !isObject(body.action)) return validationError(request, [{ type: "dict_type", loc: ["body"], msg: "Condition and action must be objects", input: body }]);
  const current = ruleId === null ? null : await bindings.database.prepare("SELECT * FROM pos_behavior_rules WHERE id=?").bind(ruleId).first<Row>();
  if (ruleId !== null && current === null) return apiError(request, 404, "Behavior rule not found");
  const id = ruleId ?? randomId();
  const values: SqlValue[] = [name, scopeType, scopeId, jsonText(body.condition), jsonText(body.action), integerValue(body.priority), booleanValue(body.active) ? 1 : 0];
  const statement = current === null
    ? bindings.database.prepare(
      `INSERT INTO pos_behavior_rules(id,name,scope_type,scope_id,condition,action,priority,active,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(id, ...values)
    : bindings.database.prepare(
      `UPDATE pos_behavior_rules SET name=?,scope_type=?,scope_id=?,condition=?,action=?,priority=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(...values, id);
  await bindings.database.batch([
    statement,
    bindings.database.prepare(
      `INSERT INTO pos_config_audit(id,actor_user_id,action,entity_type,entity_id,before_value,after_value,created_at)
       VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), user.id, current === null ? "RULE_CREATED" : "RULE_CHANGED", "RULE", id,
      current === null ? null : jsonText(ruleSnapshot(current)), jsonText({ id, name, scope_type: scopeType, scope_id: scopeId, condition: body.condition, action: body.action, priority: integerValue(body.priority), active: booleanValue(body.active) })),
  ]);
  const row = await bindings.database.prepare("SELECT * FROM pos_behavior_rules WHERE id=?").bind(id).first<Row>();
  return jsonResponse(request, row === null ? null : ruleSnapshot(row), { status: current === null ? 201 : 200 });
}

async function responseBody(response: Response): Promise<JsonObject | null> {
  try {
    const value = await response.clone().json<unknown>();
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function importedSections(config: JsonObject): { summary: Record<string, number>; error: string | null } {
  const names = ["pages", "buttons", "tags", "modifier_groups", "prompts", "rules"] as const;
  if (integerValue(config.schema_version) !== 1) return { summary: {}, error: "Unsupported POS configuration schema_version" };
  const summary: Record<string, number> = {};
  for (const name of names) {
    if (!Array.isArray(config[name])) return { summary: {}, error: `Missing configuration section: ${name}` };
    summary[name] = config[name].length;
  }
  return { summary, error: null };
}

async function applyImport(
  request: Request,
  config: JsonObject,
  bindings: RuntimeBindings,
  user: AuthorizedUser,
): Promise<Response> {
  const pageMap = new Map<number, number>();
  for (const raw of config.pages as unknown[]) {
    if (!isObject(raw)) return apiError(request, 422, "POS configuration pages must contain objects");
    const oldId = integerValue(raw.id);
    const existing = await bindings.database.prepare("SELECT id FROM pos_pages WHERE slug=?").bind(String(raw.slug ?? "")).first<{ id: number }>();
    const result = existing === null
      ? await createPage(request, raw, bindings, user)
      : await updatePage(request, existing.id, raw, bindings, user);
    if (!result.ok) return result;
    const current = await bindings.database.prepare("SELECT id FROM pos_pages WHERE slug=?").bind(String(raw.slug)).first<{ id: number }>();
    if (current !== null) pageMap.set(oldId, current.id);
  }

  const groupMap = new Map<number, number>();
  for (const raw of config.modifier_groups as unknown[]) {
    if (!isObject(raw)) return apiError(request, 422, "POS configuration modifier_groups must contain objects");
    const oldId = integerValue(raw.id);
    const existing = await bindings.database.prepare("SELECT id FROM pos_modifier_groups WHERE slug=?").bind(String(raw.slug ?? "")).first<{ id: number }>();
    const firstPass = { ...raw, modifiers: [] };
    const result = await writeModifierGroup(request, firstPass, bindings, user, existing?.id ?? null);
    if (!result.ok) return result;
    const current = await bindings.database.prepare("SELECT id FROM pos_modifier_groups WHERE slug=?").bind(String(raw.slug)).first<{ id: number }>();
    if (current !== null) groupMap.set(oldId, current.id);
  }
  for (const raw of config.modifier_groups as unknown[]) {
    if (!isObject(raw)) continue;
    const currentId = groupMap.get(integerValue(raw.id));
    if (currentId === undefined) continue;
    const modifiers = (Array.isArray(raw.modifiers) ? raw.modifiers : []).filter(isObject).map((option) => {
      const target = option.opens_modifier_group_id === null || option.opens_modifier_group_id === undefined
        ? null
        : groupMap.get(integerValue(option.opens_modifier_group_id)) ?? null;
      return { ...option, opens_modifier_group_id: target };
    });
    const result = await writeModifierGroup(request, { ...raw, modifiers }, bindings, user, currentId);
    if (!result.ok) return result;
  }

  const promptMap = new Map<number, number>();
  for (const raw of config.prompts as unknown[]) {
    if (!isObject(raw)) return apiError(request, 422, "POS configuration prompts must contain objects");
    const oldId = integerValue(raw.id);
    const existing = await bindings.database.prepare("SELECT id FROM pos_prompts WHERE slug=?").bind(String(raw.slug ?? "")).first<{ id: number }>();
    const groupId = raw.modifier_group_id === null || raw.modifier_group_id === undefined ? null : groupMap.get(integerValue(raw.modifier_group_id)) ?? null;
    const result = await writePrompt(request, { ...raw, modifier_group_id: groupId }, bindings, user, existing?.id ?? null);
    if (!result.ok) return result;
    const current = await bindings.database.prepare("SELECT id FROM pos_prompts WHERE slug=?").bind(String(raw.slug)).first<{ id: number }>();
    if (current !== null) promptMap.set(oldId, current.id);
  }

  const tagMap = new Map<number, number>();
  for (const raw of config.tags as unknown[]) {
    if (!isObject(raw)) return apiError(request, 422, "POS configuration tags must contain objects");
    const oldId = integerValue(raw.id);
    const existing = await bindings.database.prepare("SELECT id FROM pos_tags WHERE slug=?").bind(String(raw.slug ?? "")).first<{ id: number }>();
    const remappedGroups = assignments(raw.modifier_groups).flatMap((entry) => {
      const id = groupMap.get(entry.id);
      return id === undefined ? [] : [{ ...entry, id }];
    });
    const remappedPrompts = assignments(raw.prompts).flatMap((entry) => {
      const id = promptMap.get(entry.id);
      return id === undefined ? [] : [{ ...entry, id }];
    });
    const result = await writeTag(request, { ...raw, modifier_groups: remappedGroups, prompts: remappedPrompts }, bindings, user, existing?.id ?? null);
    if (!result.ok) return result;
    const current = await bindings.database.prepare("SELECT id FROM pos_tags WHERE slug=?").bind(String(raw.slug)).first<{ id: number }>();
    if (current !== null) tagMap.set(oldId, current.id);
  }

  const buttonMap = new Map<number, number>();
  for (const raw of config.buttons as unknown[]) {
    if (!isObject(raw)) return apiError(request, 422, "POS configuration buttons must contain objects");
    const pageId = pageMap.get(integerValue(raw.page_id));
    if (pageId === undefined) return apiError(request, 422, `Button ${String(raw.internal_key)} references an unknown page`);
    const layout = jsonObject(raw.layout);
    let categoryId = raw.category_id === null || raw.category_id === undefined ? null : integerValue(raw.category_id);
    if (categoryId !== null && !(await rowExists(bindings.database, "menu_categories", categoryId))) {
      const name = String(raw.category ?? "Imported");
      const existingCategory = await bindings.database.prepare("SELECT id FROM menu_categories WHERE name=?").bind(name).first<{ id: number }>();
      categoryId = existingCategory?.id ?? randomId();
      if (existingCategory === null) await bindings.database.prepare(
        "INSERT INTO menu_categories(id,name,description,active,display_order) VALUES(?,?,NULL,1,0)",
      ).bind(categoryId, name).run();
    }
    const body: JsonObject = {
      internal_key: raw.internal_key, name: raw.name, display_name: raw.display_name, description: raw.description,
      category_id: categoryId, page_id: pageId, price_cents: raw.price_cents, alternate_price_cents: raw.alternate_price_cents,
      weight_value: raw.weight_value, weight_unit: raw.weight_unit, button_type: raw.button_type, active: raw.active,
      availability: raw.availability, visual: raw.visual, routing: raw.routing, metadata: raw.metadata,
      grid_row: layout.row, grid_column: layout.column, grid_width: layout.width, grid_height: layout.height,
      display_order: layout.display_order,
      tag_ids: (Array.isArray(raw.tag_ids) ? raw.tag_ids : []).map(integerValue).flatMap((id) => tagMap.has(id) ? [tagMap.get(id) as number] : []),
      modifier_groups: assignments(raw.modifier_assignments).flatMap((entry) => groupMap.has(entry.id) ? [{ ...entry, id: groupMap.get(entry.id) as number }] : []),
      prompts: assignments(raw.prompt_assignments).flatMap((entry) => promptMap.has(entry.id) ? [{ ...entry, id: promptMap.get(entry.id) as number }] : []),
      ingredients: Array.isArray(raw.ingredients) ? raw.ingredients : [],
    };
    const existing = await bindings.database.prepare("SELECT id FROM pos_buttons WHERE internal_key=?").bind(String(raw.internal_key ?? "")).first<{ id: number }>();
    const result = existing === null
      ? await createButton(request, body, bindings, user)
      : await updateButton(request, existing.id, body, bindings, user);
    if (!result.ok) return result;
    const current = await bindings.database.prepare("SELECT id FROM pos_buttons WHERE internal_key=?").bind(String(raw.internal_key)).first<{ id: number }>();
    if (current !== null) buttonMap.set(integerValue(raw.id), current.id);
  }

  let appliedRules = 0;
  for (const raw of config.rules as unknown[]) {
    if (!isObject(raw)) return apiError(request, 422, "POS configuration rules must contain objects");
    const scopeType = String(raw.scope_type ?? "GLOBAL");
    const oldScope = raw.scope_id === null || raw.scope_id === undefined ? null : integerValue(raw.scope_id);
    const scopeId = scopeType === "TAG" && oldScope !== null ? tagMap.get(oldScope) ?? null
      : scopeType === "BUTTON" && oldScope !== null ? buttonMap.get(oldScope) ?? null : null;
    const existing = await bindings.database.prepare(
      "SELECT id FROM pos_behavior_rules WHERE name=? AND scope_type=? AND ((scope_id IS NULL AND ? IS NULL) OR scope_id=?)",
    ).bind(String(raw.name ?? ""), scopeType, scopeId, scopeId).first<{ id: number }>();
    const result = await writeRule(request, { ...raw, scope_id: scopeId }, bindings, user, existing?.id ?? null);
    if (!result.ok) return result;
    appliedRules += 1;
  }
  const { summary } = importedSections(config);
  await recordPOSAudit(bindings.database, user.id, "CONFIG_IMPORTED", "CONFIG", null, null, { summary });
  return jsonResponse(request, {
    valid: true, preview: false, summary,
    applied: { pages: pageMap.size, modifier_groups: groupMap.size, prompts: promptMap.size, tags: tagMap.size, buttons: buttonMap.size, rules: appliedRules },
    warnings: ["Import is a non-destructive merge; records omitted from the file remain unchanged."],
  });
}

export async function routePOSConfiguration(
  request: Request,
  url: URL,
  bindings: RuntimeBindings,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/pos/admin/config")) return null;
  const authorization = await requireManager(request, bindings);
  if (authorization.response !== null || authorization.user === null) return authorization.response;
  const user = authorization.user;
  const method = request.method;

  if (url.pathname === "/pos/admin/config/bootstrap") {
    if (method !== "GET") return methodNotAllowed(request, "GET");
    const includeDeleted = url.searchParams.get("include_deleted") !== "false";
    const bundle = await configurationBundle(bindings.database, { includeDeleted, resolve: false });
    bundle.permissions = Object.fromEntries(POS_PERMISSIONS.map((permission) => [permission, true]));
    bundle.audit = await auditRows(bindings.database, 50);
    return jsonResponse(request, bundle);
  }
  if (url.pathname === "/pos/admin/config/export") {
    if (method !== "GET") return methodNotAllowed(request, "GET");
    return jsonResponse(request, await configurationBundle(bindings.database), {
      headers: { "Content-Disposition": "attachment; filename=pos-configuration.json" },
    });
  }
  if (url.pathname === "/pos/admin/config/audit") {
    if (method !== "GET") return methodNotAllowed(request, "GET");
    const limit = Math.min(500, Math.max(1, integerValue(url.searchParams.get("limit"), 100)));
    return jsonResponse(request, await auditRows(bindings.database, limit));
  }
  if (url.pathname === "/pos/admin/config/import") {
    if (method !== "POST") return methodNotAllowed(request, "POST");
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    if (!isObject(body.config)) return validationError(request, [{ type: "dict_type", loc: ["body", "config"], msg: "Input should be a valid dictionary", input: body.config }]);
    const checked = importedSections(body.config);
    if (checked.error !== null) return apiError(request, 422, checked.error);
    if (booleanValue(body.preview)) return jsonResponse(request, { valid: true, preview: true, summary: checked.summary, warnings: ["Apply merges stable keys; it does not delete records omitted from the import."] });
    return applyImport(request, body.config, bindings, user);
  }
  if (url.pathname === "/pos/admin/config/pages") {
    if (method !== "POST") return methodNotAllowed(request, "POST");
    const body = await jsonBody(request); return body instanceof Response ? body : createPage(request, body, bindings, user);
  }
  let match = /^\/pos\/admin\/config\/pages\/(\d+)$/u.exec(url.pathname);
  if (match !== null) {
    const id = Number(match[1]);
    if (method === "DELETE") return disablePage(request, id, bindings, user);
    if (method !== "PUT") return methodNotAllowed(request, "DELETE, PUT");
    const body = await jsonBody(request); return body instanceof Response ? body : updatePage(request, id, body, bindings, user);
  }
  if (url.pathname === "/pos/admin/config/buttons") {
    if (method !== "POST") return methodNotAllowed(request, "POST");
    const body = await jsonBody(request); return body instanceof Response ? body : createButton(request, body, bindings, user);
  }
  match = /^\/pos\/admin\/config\/buttons\/(\d+)(?:\/(duplicate|restore))?$/u.exec(url.pathname);
  if (match !== null) {
    const id = Number(match[1]), action = match[2];
    if (action === "duplicate") return method === "POST" ? duplicateButton(request, id, bindings, user) : methodNotAllowed(request, "POST");
    if (action === "restore") return method === "POST" ? setButtonDeleted(request, id, true, bindings, user) : methodNotAllowed(request, "POST");
    if (method === "DELETE") return setButtonDeleted(request, id, false, bindings, user);
    if (method !== "PUT") return methodNotAllowed(request, "DELETE, PUT");
    const body = await jsonBody(request); return body instanceof Response ? body : updateButton(request, id, body, bindings, user);
  }
  if (url.pathname === "/pos/admin/config/layout") {
    if (method !== "PUT") return methodNotAllowed(request, "PUT");
    const body = await jsonBody(request); return body instanceof Response ? body : updateLayout(request, body, bindings, user);
  }
  if (url.pathname === "/pos/admin/config/tags") {
    if (method !== "POST") return methodNotAllowed(request, "POST");
    const body = await jsonBody(request); return body instanceof Response ? body : writeTag(request, body, bindings, user, null);
  }
  match = /^\/pos\/admin\/config\/tags\/(\d+)$/u.exec(url.pathname);
  if (match !== null) {
    const id = Number(match[1]);
    if (method === "DELETE") return disableSimple(request, bindings, user, "pos_tags", id);
    if (method !== "PUT") return methodNotAllowed(request, "DELETE, PUT");
    const body = await jsonBody(request); return body instanceof Response ? body : writeTag(request, body, bindings, user, id);
  }
  if (url.pathname === "/pos/admin/config/modifier-groups") {
    if (method !== "POST") return methodNotAllowed(request, "POST");
    const body = await jsonBody(request); return body instanceof Response ? body : writeModifierGroup(request, body, bindings, user, null);
  }
  match = /^\/pos\/admin\/config\/modifier-groups\/(\d+)$/u.exec(url.pathname);
  if (match !== null) {
    const id = Number(match[1]);
    if (method === "DELETE") return disableSimple(request, bindings, user, "pos_modifier_groups", id);
    if (method !== "PUT") return methodNotAllowed(request, "DELETE, PUT");
    const body = await jsonBody(request); return body instanceof Response ? body : writeModifierGroup(request, body, bindings, user, id);
  }
  if (url.pathname === "/pos/admin/config/prompts") {
    if (method !== "POST") return methodNotAllowed(request, "POST");
    const body = await jsonBody(request); return body instanceof Response ? body : writePrompt(request, body, bindings, user, null);
  }
  match = /^\/pos\/admin\/config\/prompts\/(\d+)$/u.exec(url.pathname);
  if (match !== null) {
    if (method !== "PUT") return methodNotAllowed(request, "PUT");
    const body = await jsonBody(request); return body instanceof Response ? body : writePrompt(request, body, bindings, user, Number(match[1]));
  }
  if (url.pathname === "/pos/admin/config/rules") {
    if (method !== "POST") return methodNotAllowed(request, "POST");
    const body = await jsonBody(request); return body instanceof Response ? body : writeRule(request, body, bindings, user, null);
  }
  match = /^\/pos\/admin\/config\/rules\/(\d+)$/u.exec(url.pathname);
  if (match !== null) {
    const id = Number(match[1]);
    if (method === "DELETE") return disableSimple(request, bindings, user, "pos_behavior_rules", id);
    if (method !== "PUT") return methodNotAllowed(request, "DELETE, PUT");
    const body = await jsonBody(request); return body instanceof Response ? body : writeRule(request, body, bindings, user, id);
  }
  return apiError(request, 404, "Not Found");
}

export async function findResolvedPOSButton(database: D1Database, id: number): Promise<JsonObject | null> {
  return resolvedButton(database, id);
}
