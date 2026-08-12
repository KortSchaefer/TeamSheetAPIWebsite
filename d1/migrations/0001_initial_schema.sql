-- TeamSheet Studio D1 schema generated from SQLAlchemy metadata.;

-- Alembic revisions 0001-0009 and SQLite startup repairs are folded into;

-- this clean baseline. Do not edit after it has been applied remotely.;

PRAGMA defer_foreign_keys = ON;

CREATE TABLE daily_rosters (
	id INTEGER NOT NULL, 
	date DATE NOT NULL, 
	store_id INTEGER, 
	entries JSON, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE employees (
	id INTEGER NOT NULL, 
	first_name VARCHAR(100) NOT NULL, 
	last_name VARCHAR(100) NOT NULL, 
	nickname VARCHAR(100), 
	role VARCHAR(9) NOT NULL, 
	employment_start_date DATE NOT NULL, 
	active BOOLEAN NOT NULL, 
	upsell_score INTEGER, 
	pitty_score INTEGER, 
	employment_days INTEGER, 
	max_section_load INTEGER, 
	notes TEXT, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE gift_tracker_entries (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	employee_name VARCHAR(255) NOT NULL, 
	week_number INTEGER NOT NULL, 
	season_year INTEGER, 
	tuesday INTEGER NOT NULL, 
	wednesday INTEGER NOT NULL, 
	thursday INTEGER NOT NULL, 
	friday INTEGER NOT NULL, 
	saturday INTEGER NOT NULL, 
	sunday INTEGER NOT NULL, 
	monday INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL
);

CREATE TABLE ingredient_catalog_imports (
	id INTEGER NOT NULL, 
	schema_version VARCHAR(30) NOT NULL, 
	source_name VARCHAR(255) NOT NULL, 
	source_sha256 VARCHAR(64) NOT NULL, 
	item_count INTEGER NOT NULL, 
	relationship_count INTEGER NOT NULL, 
	catalog_metadata JSON, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ingredients (
	id INTEGER NOT NULL, 
	name VARCHAR(150) NOT NULL, 
	unit VARCHAR(50) NOT NULL, 
	active BOOLEAN NOT NULL, 
	external_id VARCHAR(150), 
	normalized_name VARCHAR(150), 
	category VARCHAR(100), 
	stage VARCHAR(50), 
	process TEXT, 
	added_to_complete_lineage BOOLEAN DEFAULT 0 NOT NULL, 
	source_correction TEXT, 
	resolution_needed TEXT, 
	catalog_schema_version VARCHAR(30), 
	catalog_metadata JSON, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);

CREATE TABLE inventory_locations (
	id INTEGER NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	description TEXT, 
	active BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);

CREATE TABLE inventory_vendors (
	id INTEGER NOT NULL, 
	name VARCHAR(150) NOT NULL, 
	contact_name VARCHAR(150), 
	email VARCHAR(255), 
	phone VARCHAR(50), 
	lead_time_days INTEGER NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);

CREATE TABLE menu_categories (
	id INTEGER NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	description TEXT, 
	active BOOLEAN NOT NULL, 
	display_order INTEGER DEFAULT 0 NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);

CREATE TABLE payout_adjustments (
	id INTEGER NOT NULL, 
	employee_name VARCHAR(255) NOT NULL, 
	season_year INTEGER, 
	label VARCHAR(255) NOT NULL, 
	amount_cents INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE payout_rules (
	id INTEGER NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	type VARCHAR(100) NOT NULL, 
	season_year INTEGER, 
	config TEXT, 
	active BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE payout_tiers (
	id INTEGER NOT NULL, 
	label VARCHAR(255) NOT NULL, 
	season_year INTEGER, 
	min_amount_cents INTEGER NOT NULL, 
	max_amount_cents INTEGER, 
	payout_type VARCHAR(7) NOT NULL, 
	payout_value INTEGER NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE prizes (
	id INTEGER NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	season_year INTEGER, 
	description TEXT, 
	cost_cents INTEGER, 
	image_url VARCHAR(500), 
	active BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE seasons (
	id INTEGER NOT NULL, 
	year INTEGER NOT NULL, 
	start_date DATE NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE sections (
	id INTEGER NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	label VARCHAR(100) NOT NULL, 
	type VARCHAR(5) NOT NULL, 
	tables JSON, 
	tags JSON, 
	cut_order INTEGER, 
	sidework TEXT, 
	outwork TEXT, 
	max_capacity INTEGER, 
	expected_out_time VARCHAR(50), 
	max_guests INTEGER, 
	is_active BOOLEAN NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE store_preferences (
	id INTEGER NOT NULL, 
	store_number VARCHAR(50) NOT NULL, 
	daily_schedule JSON, 
	blast_minimum_percent FLOAT DEFAULT 98 NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE teamsheet_presets (
	id INTEGER NOT NULL, 
	name VARCHAR(150) NOT NULL, 
	store_id INTEGER, 
	data_json JSON, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE cobrand_deals (
	id INTEGER NOT NULL, 
	company_name VARCHAR(255) NOT NULL, 
	amount_cents INTEGER NOT NULL, 
	date_of_commission DATE, 
	date_of_payment DATE, 
	date_of_pickup DATE, 
	seller_id INTEGER, 
	logo_base64 TEXT, 
	season_year INTEGER, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(seller_id) REFERENCES employees (id)
);

CREATE TABLE ingredient_lineage (
	id INTEGER NOT NULL, 
	child_ingredient_id INTEGER NOT NULL, 
	parent_ingredient_id INTEGER NOT NULL, 
	order_index INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_ingredient_lineage_child_parent UNIQUE (child_ingredient_id, parent_ingredient_id), 
	FOREIGN KEY(child_ingredient_id) REFERENCES ingredients (id), 
	FOREIGN KEY(parent_ingredient_id) REFERENCES ingredients (id)
);

CREATE TABLE inventory_items (
	id INTEGER NOT NULL, 
	ingredient_id INTEGER, 
	name VARCHAR(150) NOT NULL, 
	category VARCHAR(100), 
	sku VARCHAR(100), 
	base_unit VARCHAR(30) NOT NULL, 
	purchase_unit VARCHAR(30), 
	purchase_to_base NUMERIC(12, 4) NOT NULL, 
	default_location_id INTEGER, 
	cost_cents INTEGER NOT NULL, 
	shelf_life_days INTEGER, 
	active BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(ingredient_id) REFERENCES ingredients (id), 
	FOREIGN KEY(default_location_id) REFERENCES inventory_locations (id)
);

CREATE TABLE menu_items (
	id INTEGER NOT NULL, 
	category_id INTEGER, 
	name VARCHAR(150) NOT NULL, 
	price_cents INTEGER NOT NULL, 
	active BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(category_id) REFERENCES menu_categories (id)
);

CREATE TABLE pos_credentials (
	id INTEGER NOT NULL, 
	employee_id INTEGER NOT NULL, 
	pin_lookup_digest VARCHAR(64) NOT NULL, 
	pin_hash VARCHAR(255) NOT NULL, 
	access_role VARCHAR(7) NOT NULL, 
	active BOOLEAN NOT NULL, 
	failed_attempts INTEGER NOT NULL, 
	locked_until DATETIME, 
	last_used_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(employee_id) REFERENCES employees (id)
);

CREATE TABLE pos_tables (
	id INTEGER NOT NULL, 
	table_number INTEGER NOT NULL, 
	client_request_id VARCHAR(64), 
	active_number_key VARCHAR(20), 
	owner_employee_id INTEGER NOT NULL, 
	status VARCHAR(6) NOT NULL, 
	progress VARCHAR(14) NOT NULL, 
	revision INTEGER NOT NULL, 
	opened_at DATETIME NOT NULL, 
	closed_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(owner_employee_id) REFERENCES employees (id)
);

CREATE TABLE prize_assignments (
	id INTEGER NOT NULL, 
	employee_name VARCHAR(255) NOT NULL, 
	season_year INTEGER, 
	prize_id INTEGER NOT NULL, 
	notes TEXT, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(prize_id) REFERENCES prizes (id)
);

CREATE TABLE pyos_credits (
	id INTEGER NOT NULL, 
	employee_id INTEGER NOT NULL, 
	balance INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (employee_id), 
	FOREIGN KEY(employee_id) REFERENCES employees (id)
);

CREATE TABLE users (
	id INTEGER NOT NULL, 
	email VARCHAR(255) NOT NULL, 
	password_hash VARCHAR(255) NOT NULL, 
	full_name VARCHAR(255) NOT NULL, 
	role VARCHAR(7) NOT NULL, 
	employee_id INTEGER, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(employee_id) REFERENCES employees (id)
);

CREATE TABLE inventory_balances (
	id INTEGER NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	location_id INTEGER NOT NULL, 
	quantity_on_hand NUMERIC(12, 4) NOT NULL, 
	minimum_quantity NUMERIC(12, 4) NOT NULL, 
	par_quantity NUMERIC(12, 4) NOT NULL, 
	maximum_quantity NUMERIC(12, 4), 
	planning_active BOOLEAN DEFAULT 1 NOT NULL, 
	lower_tolerance_percent NUMERIC(6, 2), 
	upper_tolerance_percent NUMERIC(6, 2), 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_inventory_balance_item_location UNIQUE (inventory_item_id, location_id), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id)
);

CREATE TABLE inventory_count_templates (
	id INTEGER NOT NULL, 
	name VARCHAR(150) NOT NULL, 
	description TEXT, 
	active BOOLEAN NOT NULL, 
	created_by_user_id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (name), 
	FOREIGN KEY(created_by_user_id) REFERENCES users (id)
);

CREATE TABLE inventory_item_aliases (
	id INTEGER NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	normalized_alias VARCHAR(200) NOT NULL, 
	source VARCHAR(7) NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_inventory_item_alias UNIQUE (inventory_item_id, normalized_alias), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id)
);

CREATE TABLE inventory_purchase_orders (
	id INTEGER NOT NULL, 
	vendor_id INTEGER NOT NULL, 
	status VARCHAR(18) NOT NULL, 
	expected_date DATE, 
	notes TEXT, 
	external_reference VARCHAR(100), 
	import_source_hash VARCHAR(64), 
	imported_filename VARCHAR(255), 
	created_by_user_id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_purchase_order_vendor_reference UNIQUE (vendor_id, external_reference), 
	FOREIGN KEY(vendor_id) REFERENCES inventory_vendors (id), 
	FOREIGN KEY(created_by_user_id) REFERENCES users (id)
);

CREATE TABLE inventory_vendor_items (
	id INTEGER NOT NULL, 
	vendor_id INTEGER NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	vendor_sku VARCHAR(100), 
	unit_price_cents INTEGER NOT NULL, 
	pack_quantity NUMERIC(12, 4) NOT NULL, 
	preferred BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_vendor_inventory_item UNIQUE (vendor_id, inventory_item_id), 
	FOREIGN KEY(vendor_id) REFERENCES inventory_vendors (id), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id)
);

CREATE TABLE inventory_voice_sessions (
	id INTEGER NOT NULL, 
	client_session_id VARCHAR(36) NOT NULL, 
	manager_user_id INTEGER NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	current_location_id INTEGER NOT NULL, 
	started_at DATETIME NOT NULL, 
	finished_at DATETIME, 
	last_client_sequence INTEGER NOT NULL, 
	device_metadata JSON, 
	transcription_model VARCHAR(100) NOT NULL, 
	normalization_model VARCHAR(100) NOT NULL, 
	prompt_version VARCHAR(50) NOT NULL, 
	audio_delete_after DATETIME, 
	error_message TEXT, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(manager_user_id) REFERENCES users (id), 
	FOREIGN KEY(current_location_id) REFERENCES inventory_locations (id)
);

CREATE TABLE inventory_weekday_targets (
	id INTEGER NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	location_id INTEGER NOT NULL, 
	weekday INTEGER NOT NULL, 
	target_quantity NUMERIC(12, 4) NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_inventory_weekday_target UNIQUE (inventory_item_id, location_id, weekday), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id)
);

CREATE TABLE pos_terminal_sessions (
	id INTEGER NOT NULL, 
	credential_id INTEGER NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	issued_at DATETIME NOT NULL, 
	last_seen_at DATETIME NOT NULL, 
	expires_at DATETIME NOT NULL, 
	revoked_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(credential_id) REFERENCES pos_credentials (id)
);

CREATE TABLE pyos_audit (
	id INTEGER NOT NULL, 
	actor_user_id INTEGER NOT NULL, 
	employee_id INTEGER, 
	action VARCHAR(50) NOT NULL, 
	delta INTEGER, 
	details_json JSON, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(actor_user_id) REFERENCES users (id), 
	FOREIGN KEY(employee_id) REFERENCES employees (id)
);

CREATE TABLE pyos_requests (
	id INTEGER NOT NULL, 
	employee_id INTEGER NOT NULL, 
	section_id INTEGER NOT NULL, 
	date DATE NOT NULL, 
	shift VARCHAR(2) NOT NULL, 
	status VARCHAR(8) NOT NULL, 
	notes TEXT, 
	created_by_user_id INTEGER NOT NULL, 
	approved_by_user_id INTEGER, 
	denied_by_user_id INTEGER, 
	revoked_by_user_id INTEGER, 
	approved_at DATETIME, 
	denied_at DATETIME, 
	revoked_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_pyos_section_date_shift UNIQUE (section_id, date, shift), 
	FOREIGN KEY(employee_id) REFERENCES employees (id), 
	FOREIGN KEY(section_id) REFERENCES sections (id), 
	FOREIGN KEY(created_by_user_id) REFERENCES users (id), 
	FOREIGN KEY(approved_by_user_id) REFERENCES users (id), 
	FOREIGN KEY(denied_by_user_id) REFERENCES users (id), 
	FOREIGN KEY(revoked_by_user_id) REFERENCES users (id)
);

CREATE TABLE recipe_items (
	id INTEGER NOT NULL, 
	menu_item_id INTEGER NOT NULL, 
	ingredient_id INTEGER NOT NULL, 
	quantity FLOAT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(menu_item_id) REFERENCES menu_items (id), 
	FOREIGN KEY(ingredient_id) REFERENCES ingredients (id)
);

CREATE TABLE shifts (
	id INTEGER NOT NULL, 
	date DATE NOT NULL, 
	time_period VARCHAR(6) NOT NULL, 
	store_id INTEGER, 
	created_by_user_id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(created_by_user_id) REFERENCES users (id)
);

CREATE TABLE inventory_count_template_lines (
	id INTEGER NOT NULL, 
	template_id INTEGER NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	location_id INTEGER NOT NULL, 
	display_order INTEGER NOT NULL, 
	preferred_unit VARCHAR(30), 
	PRIMARY KEY (id), 
	CONSTRAINT uq_count_template_item_location UNIQUE (template_id, inventory_item_id, location_id), 
	FOREIGN KEY(template_id) REFERENCES inventory_count_templates (id), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id)
);

CREATE TABLE inventory_counts (
	id INTEGER NOT NULL, 
	location_id INTEGER NOT NULL, 
	template_id INTEGER, 
	status VARCHAR(9) NOT NULL, 
	counted_by_user_id INTEGER NOT NULL, 
	reviewed_by_user_id INTEGER, 
	notes TEXT, 
	revision INTEGER DEFAULT 1 NOT NULL, 
	approved_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id), 
	FOREIGN KEY(template_id) REFERENCES inventory_count_templates (id), 
	FOREIGN KEY(counted_by_user_id) REFERENCES users (id), 
	FOREIGN KEY(reviewed_by_user_id) REFERENCES users (id)
);

CREATE TABLE inventory_purchase_order_lines (
	id INTEGER NOT NULL, 
	purchase_order_id INTEGER NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	location_id INTEGER, 
	ordered_quantity NUMERIC(12, 4) NOT NULL, 
	unit_price_cents INTEGER NOT NULL, 
	received_quantity NUMERIC(12, 4) NOT NULL, 
	purchase_unit VARCHAR(30), 
	quantity_per_purchase_unit NUMERIC(12, 4) DEFAULT 1 NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(purchase_order_id) REFERENCES inventory_purchase_orders (id), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id)
);

CREATE TABLE inventory_receiving (
	id INTEGER NOT NULL, 
	purchase_order_id INTEGER NOT NULL, 
	received_by_user_id INTEGER NOT NULL, 
	invoice_number VARCHAR(100), 
	notes TEXT, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(purchase_order_id) REFERENCES inventory_purchase_orders (id), 
	FOREIGN KEY(received_by_user_id) REFERENCES users (id)
);

CREATE TABLE inventory_voice_utterances (
	id INTEGER NOT NULL, 
	session_id INTEGER NOT NULL, 
	client_event_id VARCHAR(36) NOT NULL, 
	sequence INTEGER NOT NULL, 
	realtime_item_id VARCHAR(100), 
	started_at DATETIME, 
	ended_at DATETIME, 
	transcript TEXT NOT NULL, 
	normalized_payload JSON, 
	status VARCHAR(19) NOT NULL, 
	audio_object_key VARCHAR(500), 
	audio_missing BOOLEAN NOT NULL, 
	error_details TEXT, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_voice_utterance_client_event UNIQUE (session_id, client_event_id), 
	CONSTRAINT uq_voice_utterance_sequence UNIQUE (session_id, sequence), 
	FOREIGN KEY(session_id) REFERENCES inventory_voice_sessions (id)
);

CREATE TABLE pos_orders (
	id INTEGER NOT NULL, 
	status VARCHAR(6) NOT NULL, 
	shift_id INTEGER, 
	server_id INTEGER, 
	table_id INTEGER, 
	check_number INTEGER DEFAULT 1 NOT NULL, 
	progress VARCHAR(14) DEFAULT 'FOOD_UNORDERED' NOT NULL, 
	subtotal_cents INTEGER DEFAULT 0 NOT NULL, 
	tax_cents INTEGER DEFAULT 0 NOT NULL, 
	tip_cents INTEGER DEFAULT 0 NOT NULL, 
	total_cents INTEGER DEFAULT 0 NOT NULL, 
	print_count INTEGER DEFAULT 0 NOT NULL, 
	printed_at DATETIME, 
	closed_at DATETIME, 
	table_label VARCHAR(50), 
	notes TEXT, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(shift_id) REFERENCES shifts (id), 
	FOREIGN KEY(server_id) REFERENCES employees (id), 
	FOREIGN KEY(table_id) REFERENCES pos_tables (id)
);

CREATE TABLE team_sheets (
	id INTEGER NOT NULL, 
	shift_id INTEGER NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	status VARCHAR(9) NOT NULL, 
	notes TEXT, 
	created_by_user_id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(shift_id) REFERENCES shifts (id), 
	FOREIGN KEY(created_by_user_id) REFERENCES users (id)
);

CREATE TABLE inventory_count_lines (
	id INTEGER NOT NULL, 
	count_id INTEGER NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	counted_quantity NUMERIC(12, 4) NOT NULL, 
	expected_quantity NUMERIC(12, 4), 
	notes TEXT, 
	display_order INTEGER DEFAULT 0 NOT NULL, 
	is_counted BOOLEAN DEFAULT 1 NOT NULL, 
	source VARCHAR(20), 
	confidence FLOAT, 
	review_status VARCHAR(30) DEFAULT 'READY' NOT NULL, 
	evidence TEXT, 
	revision INTEGER DEFAULT 1 NOT NULL, 
	updated_by_user_id INTEGER, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_inventory_count_line UNIQUE (count_id, inventory_item_id), 
	FOREIGN KEY(count_id) REFERENCES inventory_counts (id), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id), 
	FOREIGN KEY(updated_by_user_id) REFERENCES users (id)
);

CREATE TABLE inventory_receiving_lines (
	id INTEGER NOT NULL, 
	receiving_id INTEGER NOT NULL, 
	purchase_order_line_id INTEGER, 
	inventory_item_id INTEGER NOT NULL, 
	location_id INTEGER NOT NULL, 
	received_quantity NUMERIC(12, 4) NOT NULL, 
	unit_price_cents INTEGER NOT NULL, 
	lot_number VARCHAR(100), 
	expiration_date DATE, 
	notes TEXT, 
	PRIMARY KEY (id), 
	FOREIGN KEY(receiving_id) REFERENCES inventory_receiving (id), 
	FOREIGN KEY(purchase_order_line_id) REFERENCES inventory_purchase_order_lines (id), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id)
);

CREATE TABLE inventory_voice_entries (
	id INTEGER NOT NULL, 
	session_id INTEGER NOT NULL, 
	utterance_id INTEGER NOT NULL, 
	location_id INTEGER NOT NULL, 
	inventory_item_id INTEGER, 
	action VARCHAR(15) NOT NULL, 
	spoken_item VARCHAR(200), 
	spoken_quantity NUMERIC(12, 4), 
	spoken_unit VARCHAR(50), 
	normalized_quantity NUMERIC(12, 4), 
	evidence TEXT NOT NULL, 
	ambiguity_reason TEXT, 
	review_status VARCHAR(13) NOT NULL, 
	supersedes_entry_id INTEGER, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(session_id) REFERENCES inventory_voice_sessions (id), 
	FOREIGN KEY(utterance_id) REFERENCES inventory_voice_utterances (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id), 
	FOREIGN KEY(supersedes_entry_id) REFERENCES inventory_voice_entries (id)
);

CREATE TABLE inventory_voice_session_counts (
	id INTEGER NOT NULL, 
	session_id INTEGER NOT NULL, 
	location_id INTEGER NOT NULL, 
	inventory_count_id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_voice_session_count_location UNIQUE (session_id, location_id), 
	FOREIGN KEY(session_id) REFERENCES inventory_voice_sessions (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id), 
	UNIQUE (inventory_count_id), 
	FOREIGN KEY(inventory_count_id) REFERENCES inventory_counts (id)
);

CREATE TABLE outwork_tasks (
	id INTEGER NOT NULL, 
	team_sheet_id INTEGER NOT NULL, 
	label VARCHAR(255) NOT NULL, 
	description TEXT, 
	PRIMARY KEY (id), 
	FOREIGN KEY(team_sheet_id) REFERENCES team_sheets (id)
);

CREATE TABLE pos_order_items (
	id INTEGER NOT NULL, 
	order_id INTEGER NOT NULL, 
	menu_item_id INTEGER NOT NULL, 
	quantity INTEGER NOT NULL, 
	price_cents INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(order_id) REFERENCES pos_orders (id), 
	FOREIGN KEY(menu_item_id) REFERENCES menu_items (id)
);

CREATE TABLE pos_payments (
	id INTEGER NOT NULL, 
	order_id INTEGER NOT NULL, 
	amount_cents INTEGER NOT NULL, 
	method VARCHAR(50) NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(order_id) REFERENCES pos_orders (id)
);

CREATE TABLE pos_table_events (
	id INTEGER NOT NULL, 
	table_id INTEGER NOT NULL, 
	order_id INTEGER, 
	employee_id INTEGER NOT NULL, 
	event_type VARCHAR(40) NOT NULL, 
	details JSON, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(table_id) REFERENCES pos_tables (id), 
	FOREIGN KEY(order_id) REFERENCES pos_orders (id), 
	FOREIGN KEY(employee_id) REFERENCES employees (id)
);

CREATE TABLE sidework_tasks (
	id INTEGER NOT NULL, 
	team_sheet_id INTEGER NOT NULL, 
	label VARCHAR(255) NOT NULL, 
	description TEXT, 
	PRIMARY KEY (id), 
	FOREIGN KEY(team_sheet_id) REFERENCES team_sheets (id)
);

CREATE TABLE team_sheet_assignments (
	id INTEGER NOT NULL, 
	team_sheet_id INTEGER NOT NULL, 
	employee_id INTEGER NOT NULL, 
	section_id INTEGER NOT NULL, 
	role_label VARCHAR(100), 
	order_index INTEGER, 
	PRIMARY KEY (id), 
	FOREIGN KEY(team_sheet_id) REFERENCES team_sheets (id), 
	FOREIGN KEY(employee_id) REFERENCES employees (id), 
	FOREIGN KEY(section_id) REFERENCES sections (id)
);

CREATE TABLE outwork_assignments (
	id INTEGER NOT NULL, 
	task_id INTEGER NOT NULL, 
	employee_id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(task_id) REFERENCES outwork_tasks (id), 
	FOREIGN KEY(employee_id) REFERENCES employees (id)
);

CREATE TABLE sidework_assignments (
	id INTEGER NOT NULL, 
	task_id INTEGER NOT NULL, 
	employee_id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(task_id) REFERENCES sidework_tasks (id), 
	FOREIGN KEY(employee_id) REFERENCES employees (id)
);

CREATE TABLE stock_movements (
	id INTEGER NOT NULL, 
	ingredient_id INTEGER NOT NULL, 
	inventory_item_id INTEGER, 
	location_id INTEGER, 
	quantity_change FLOAT NOT NULL, 
	reason VARCHAR(100) NOT NULL, 
	order_item_id INTEGER, 
	source_event_key VARCHAR(255), 
	created_by_user_id INTEGER, 
	lot_number VARCHAR(100), 
	expiration_date DATE, 
	notes TEXT, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(ingredient_id) REFERENCES ingredients (id), 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id), 
	FOREIGN KEY(location_id) REFERENCES inventory_locations (id), 
	FOREIGN KEY(order_item_id) REFERENCES pos_order_items (id), 
	FOREIGN KEY(created_by_user_id) REFERENCES users (id)
);

CREATE INDEX ix_cobrand_deals_season_year ON cobrand_deals (season_year);

CREATE INDEX ix_daily_rosters_date ON daily_rosters (date);

CREATE INDEX ix_daily_rosters_store_id ON daily_rosters (store_id);

CREATE INDEX ix_gift_tracker_entries_employee_name ON gift_tracker_entries (employee_name);

CREATE INDEX ix_gift_tracker_entries_season_year ON gift_tracker_entries (season_year);

CREATE INDEX ix_gift_tracker_entries_week_number ON gift_tracker_entries (week_number);

CREATE UNIQUE INDEX ix_ingredient_catalog_imports_source_sha256 ON ingredient_catalog_imports (source_sha256);

CREATE INDEX ix_ingredient_lineage_child_ingredient_id ON ingredient_lineage (child_ingredient_id);

CREATE INDEX ix_ingredient_lineage_parent_ingredient_id ON ingredient_lineage (parent_ingredient_id);

CREATE INDEX ix_ingredients_category ON ingredients (category);

CREATE UNIQUE INDEX ix_ingredients_external_id ON ingredients (external_id);

CREATE INDEX ix_ingredients_normalized_name ON ingredients (normalized_name);

CREATE INDEX ix_ingredients_stage ON ingredients (stage);

CREATE INDEX ix_inventory_count_lines_review_status ON inventory_count_lines (review_status);

CREATE INDEX ix_inventory_count_template_lines_template_id ON inventory_count_template_lines (template_id);

CREATE INDEX ix_inventory_counts_template_id ON inventory_counts (template_id);

CREATE INDEX ix_inventory_item_aliases_inventory_item_id ON inventory_item_aliases (inventory_item_id);

CREATE INDEX ix_inventory_item_aliases_normalized_alias ON inventory_item_aliases (normalized_alias);

CREATE INDEX ix_inventory_items_category ON inventory_items (category);

CREATE UNIQUE INDEX ix_inventory_items_ingredient_id ON inventory_items (ingredient_id);

CREATE INDEX ix_inventory_items_name ON inventory_items (name);

CREATE UNIQUE INDEX ix_inventory_items_sku ON inventory_items (sku);

CREATE INDEX ix_inventory_purchase_order_lines_location_id ON inventory_purchase_order_lines (location_id);

CREATE INDEX ix_inventory_purchase_orders_external_reference ON inventory_purchase_orders (external_reference);

CREATE UNIQUE INDEX ix_inventory_purchase_orders_import_source_hash ON inventory_purchase_orders (import_source_hash);

CREATE INDEX ix_inventory_receiving_lines_purchase_order_line_id ON inventory_receiving_lines (purchase_order_line_id);

CREATE INDEX ix_inventory_voice_entries_inventory_item_id ON inventory_voice_entries (inventory_item_id);

CREATE INDEX ix_inventory_voice_entries_location_id ON inventory_voice_entries (location_id);

CREATE INDEX ix_inventory_voice_entries_review_status ON inventory_voice_entries (review_status);

CREATE INDEX ix_inventory_voice_entries_session_id ON inventory_voice_entries (session_id);

CREATE INDEX ix_inventory_voice_entries_utterance_id ON inventory_voice_entries (utterance_id);

CREATE INDEX ix_inventory_voice_session_counts_session_id ON inventory_voice_session_counts (session_id);

CREATE INDEX ix_inventory_voice_sessions_audio_delete_after ON inventory_voice_sessions (audio_delete_after);

CREATE UNIQUE INDEX ix_inventory_voice_sessions_client_session_id ON inventory_voice_sessions (client_session_id);

CREATE INDEX ix_inventory_voice_sessions_manager_user_id ON inventory_voice_sessions (manager_user_id);

CREATE INDEX ix_inventory_voice_sessions_status ON inventory_voice_sessions (status);

CREATE INDEX ix_inventory_voice_utterances_session_id ON inventory_voice_utterances (session_id);

CREATE INDEX ix_inventory_voice_utterances_status ON inventory_voice_utterances (status);

CREATE INDEX ix_inventory_weekday_targets_inventory_item_id ON inventory_weekday_targets (inventory_item_id);

CREATE INDEX ix_inventory_weekday_targets_location_id ON inventory_weekday_targets (location_id);

CREATE INDEX ix_payout_adjustments_employee_name ON payout_adjustments (employee_name);

CREATE INDEX ix_payout_adjustments_season_year ON payout_adjustments (season_year);

CREATE INDEX ix_payout_rules_season_year ON payout_rules (season_year);

CREATE INDEX ix_payout_tiers_season_year ON payout_tiers (season_year);

CREATE UNIQUE INDEX ix_pos_credentials_employee_id ON pos_credentials (employee_id);

CREATE UNIQUE INDEX ix_pos_credentials_pin_lookup_digest ON pos_credentials (pin_lookup_digest);

CREATE INDEX ix_pos_orders_table_id ON pos_orders (table_id);

CREATE INDEX ix_pos_table_events_employee_id ON pos_table_events (employee_id);

CREATE INDEX ix_pos_table_events_event_type ON pos_table_events (event_type);

CREATE INDEX ix_pos_table_events_order_id ON pos_table_events (order_id);

CREATE INDEX ix_pos_table_events_table_id ON pos_table_events (table_id);

CREATE UNIQUE INDEX ix_pos_tables_active_number_key ON pos_tables (active_number_key);

CREATE UNIQUE INDEX ix_pos_tables_client_request_id ON pos_tables (client_request_id);

CREATE INDEX ix_pos_tables_owner_employee_id ON pos_tables (owner_employee_id);

CREATE INDEX ix_pos_tables_status ON pos_tables (status);

CREATE INDEX ix_pos_tables_table_number ON pos_tables (table_number);

CREATE INDEX ix_pos_terminal_sessions_credential_id ON pos_terminal_sessions (credential_id);

CREATE UNIQUE INDEX ix_pos_terminal_sessions_token_hash ON pos_terminal_sessions (token_hash);

CREATE INDEX ix_prize_assignments_employee_name ON prize_assignments (employee_name);

CREATE INDEX ix_prize_assignments_season_year ON prize_assignments (season_year);

CREATE INDEX ix_prizes_season_year ON prizes (season_year);

CREATE UNIQUE INDEX ix_seasons_year ON seasons (year);

CREATE INDEX ix_stock_movements_created_by_user_id ON stock_movements (created_by_user_id);

CREATE INDEX ix_stock_movements_inventory_item_id ON stock_movements (inventory_item_id);

CREATE INDEX ix_stock_movements_location_id ON stock_movements (location_id);

CREATE UNIQUE INDEX ix_stock_movements_source_event_key ON stock_movements (source_event_key);

CREATE UNIQUE INDEX ix_store_preferences_store_number ON store_preferences (store_number);

CREATE INDEX ix_teamsheet_presets_store_id ON teamsheet_presets (store_id);

CREATE UNIQUE INDEX ix_users_email ON users (email);

CREATE INDEX ix_users_id ON users (id);

PRAGMA defer_foreign_keys = OFF;
