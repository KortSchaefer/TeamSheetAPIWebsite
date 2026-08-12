ALTER TABLE recipe_items ADD COLUMN selection_type VARCHAR(20) NOT NULL DEFAULT 'INCLUDED';
ALTER TABLE recipe_items ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
PRAGMA defer_foreign_keys = ON;
CREATE TABLE pos_order_items_rebuilt (
  id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  menu_item_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  modifier_total_cents INTEGER NOT NULL DEFAULT 0,
  display_name_snapshot VARCHAR(150),
  configuration_snapshot JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(order_id) REFERENCES pos_orders(id),
  FOREIGN KEY(menu_item_id) REFERENCES menu_items(id)
);
INSERT INTO pos_order_items_rebuilt
  (id, order_id, menu_item_id, quantity, price_cents, modifier_total_cents,
   display_name_snapshot, configuration_snapshot, created_at, updated_at)
SELECT id, order_id, menu_item_id, quantity, price_cents, 0, NULL, NULL,
       created_at, updated_at
FROM pos_order_items;
DROP TABLE pos_order_items;
ALTER TABLE pos_order_items_rebuilt RENAME TO pos_order_items;

CREATE TABLE pos_pages (
  id INTEGER NOT NULL,
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  metadata JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE pos_tags (
  id INTEGER NOT NULL,
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  color VARCHAR(20),
  active BOOLEAN NOT NULL DEFAULT 1,
  behavior JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE pos_modifier_groups (
  id INTEGER NOT NULL,
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(120) NOT NULL,
  prompt VARCHAR(220),
  required BOOLEAN NOT NULL DEFAULT 0,
  minimum_selections INTEGER NOT NULL DEFAULT 0,
  maximum_selections INTEGER NOT NULL DEFAULT 1,
  allow_quantities BOOLEAN NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT 1,
  conditional_visibility JSON,
  metadata JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE pos_buttons (
  id INTEGER NOT NULL,
  internal_key VARCHAR(120) NOT NULL,
  menu_item_id INTEGER NOT NULL,
  page_id INTEGER NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  button_type VARCHAR(40) NOT NULL DEFAULT 'PRODUCT',
  alternate_price_cents INTEGER,
  weight_value FLOAT,
  weight_unit VARCHAR(30),
  active BOOLEAN NOT NULL DEFAULT 1,
  deleted_at DATETIME,
  availability JSON,
  visual JSON,
  routing JSON,
  metadata JSON,
  grid_row INTEGER NOT NULL DEFAULT 1,
  grid_column INTEGER NOT NULL DEFAULT 1,
  grid_width INTEGER NOT NULL DEFAULT 1,
  grid_height INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(menu_item_id) REFERENCES menu_items(id),
  FOREIGN KEY(page_id) REFERENCES pos_pages(id)
);

CREATE TABLE pos_button_tags (
  id INTEGER NOT NULL,
  button_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_pos_button_tag UNIQUE(button_id, tag_id),
  FOREIGN KEY(button_id) REFERENCES pos_buttons(id),
  FOREIGN KEY(tag_id) REFERENCES pos_tags(id)
);

CREATE TABLE pos_modifiers (
  id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  internal_key VARCHAR(120) NOT NULL,
  name VARCHAR(120) NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  default_selected BOOLEAN NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  opens_modifier_group_id INTEGER,
  conditional_visibility JSON,
  metadata JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_pos_modifier_group_key UNIQUE(group_id, internal_key),
  FOREIGN KEY(group_id) REFERENCES pos_modifier_groups(id),
  FOREIGN KEY(opens_modifier_group_id) REFERENCES pos_modifier_groups(id)
);

CREATE TABLE pos_button_modifier_groups (
  id INTEGER NOT NULL,
  button_id INTEGER NOT NULL,
  modifier_group_id INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  disabled BOOLEAN NOT NULL DEFAULT 0,
  override_config JSON,
  PRIMARY KEY (id),
  CONSTRAINT uq_pos_button_modifier_group UNIQUE(button_id, modifier_group_id),
  FOREIGN KEY(button_id) REFERENCES pos_buttons(id),
  FOREIGN KEY(modifier_group_id) REFERENCES pos_modifier_groups(id)
);

CREATE TABLE pos_tag_modifier_groups (
  id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  modifier_group_id INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  override_config JSON,
  PRIMARY KEY (id),
  CONSTRAINT uq_pos_tag_modifier_group UNIQUE(tag_id, modifier_group_id),
  FOREIGN KEY(tag_id) REFERENCES pos_tags(id),
  FOREIGN KEY(modifier_group_id) REFERENCES pos_modifier_groups(id)
);

CREATE TABLE pos_prompts (
  id INTEGER NOT NULL,
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(120) NOT NULL,
  message VARCHAR(240) NOT NULL,
  modifier_group_id INTEGER,
  required BOOLEAN NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT 1,
  config JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(modifier_group_id) REFERENCES pos_modifier_groups(id)
);

CREATE TABLE pos_button_prompts (
  id INTEGER NOT NULL,
  button_id INTEGER NOT NULL,
  prompt_id INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  disabled BOOLEAN NOT NULL DEFAULT 0,
  override_config JSON,
  PRIMARY KEY (id),
  CONSTRAINT uq_pos_button_prompt UNIQUE(button_id, prompt_id),
  FOREIGN KEY(button_id) REFERENCES pos_buttons(id),
  FOREIGN KEY(prompt_id) REFERENCES pos_prompts(id)
);

CREATE TABLE pos_tag_prompts (
  id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  prompt_id INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  override_config JSON,
  PRIMARY KEY (id),
  CONSTRAINT uq_pos_tag_prompt UNIQUE(tag_id, prompt_id),
  FOREIGN KEY(tag_id) REFERENCES pos_tags(id),
  FOREIGN KEY(prompt_id) REFERENCES pos_prompts(id)
);

CREATE TABLE pos_behavior_rules (
  id INTEGER NOT NULL,
  name VARCHAR(150) NOT NULL,
  scope_type VARCHAR(30) NOT NULL,
  scope_id INTEGER,
  condition JSON NOT NULL,
  action JSON NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE pos_config_audit (
  id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER,
  before_value JSON,
  after_value JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY(actor_user_id) REFERENCES users(id)
);

CREATE INDEX ix_pos_pages_active_order ON pos_pages(active, display_order);
CREATE INDEX ix_pos_buttons_page_order ON pos_buttons(page_id, active, deleted_at, display_order);
CREATE INDEX ix_pos_buttons_menu_item_id ON pos_buttons(menu_item_id);
CREATE INDEX ix_pos_button_tags_button_id ON pos_button_tags(button_id);
CREATE INDEX ix_pos_button_tags_tag_id ON pos_button_tags(tag_id);
CREATE INDEX ix_pos_modifiers_group_order ON pos_modifiers(group_id, active, display_order);
CREATE INDEX ix_pos_button_modifier_groups_button_id ON pos_button_modifier_groups(button_id);
CREATE INDEX ix_pos_tag_modifier_groups_tag_id ON pos_tag_modifier_groups(tag_id);
CREATE INDEX ix_pos_button_prompts_button_id ON pos_button_prompts(button_id);
CREATE INDEX ix_pos_tag_prompts_tag_id ON pos_tag_prompts(tag_id);
CREATE INDEX ix_pos_behavior_rules_scope ON pos_behavior_rules(scope_type, scope_id, active, priority);
CREATE INDEX ix_pos_config_audit_entity ON pos_config_audit(entity_type, entity_id, created_at);
CREATE INDEX ix_pos_behavior_rules_active ON pos_behavior_rules(active);
CREATE INDEX ix_pos_behavior_rules_scope_id ON pos_behavior_rules(scope_id);
CREATE INDEX ix_pos_behavior_rules_scope_type ON pos_behavior_rules(scope_type);
CREATE INDEX ix_pos_button_modifier_groups_modifier_group_id ON pos_button_modifier_groups(modifier_group_id);
CREATE INDEX ix_pos_button_prompts_prompt_id ON pos_button_prompts(prompt_id);
CREATE INDEX ix_pos_buttons_active ON pos_buttons(active);
CREATE INDEX ix_pos_buttons_deleted_at ON pos_buttons(deleted_at);
CREATE UNIQUE INDEX ix_pos_buttons_internal_key ON pos_buttons(internal_key);
CREATE INDEX ix_pos_buttons_page_id ON pos_buttons(page_id);
CREATE INDEX ix_pos_config_audit_action ON pos_config_audit(action);
CREATE INDEX ix_pos_config_audit_actor_user_id ON pos_config_audit(actor_user_id);
CREATE INDEX ix_pos_config_audit_created_at ON pos_config_audit(created_at);
CREATE INDEX ix_pos_config_audit_entity_id ON pos_config_audit(entity_id);
CREATE INDEX ix_pos_config_audit_entity_type ON pos_config_audit(entity_type);
CREATE INDEX ix_pos_modifier_groups_active ON pos_modifier_groups(active);
CREATE UNIQUE INDEX ix_pos_modifier_groups_slug ON pos_modifier_groups(slug);
CREATE INDEX ix_pos_modifiers_group_id ON pos_modifiers(group_id);
CREATE INDEX ix_pos_pages_active ON pos_pages(active);
CREATE UNIQUE INDEX ix_pos_pages_slug ON pos_pages(slug);
CREATE INDEX ix_pos_prompts_active ON pos_prompts(active);
CREATE INDEX ix_pos_prompts_modifier_group_id ON pos_prompts(modifier_group_id);
CREATE UNIQUE INDEX ix_pos_prompts_slug ON pos_prompts(slug);
CREATE INDEX ix_pos_tag_modifier_groups_modifier_group_id ON pos_tag_modifier_groups(modifier_group_id);
CREATE INDEX ix_pos_tag_prompts_prompt_id ON pos_tag_prompts(prompt_id);
CREATE INDEX ix_pos_tags_active ON pos_tags(active);
CREATE UNIQUE INDEX ix_pos_tags_slug ON pos_tags(slug);
