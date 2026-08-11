-- AGM Floor tables are appended to the existing D1 baseline.
CREATE TABLE agm_stores (
  id INTEGER NOT NULL,
  store_number VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  timezone VARCHAR(80) NOT NULL,
  active BOOLEAN NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE agm_layouts (
  id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  name VARCHAR(120) NOT NULL,
  version INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL,
  revision INTEGER NOT NULL,
  canvas_width INTEGER NOT NULL,
  canvas_height INTEGER NOT NULL,
  areas JSON,
  fixtures JSON,
  published_at DATETIME,
  created_by_user_id INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_agm_layout_version UNIQUE (store_id, name, version),
  FOREIGN KEY(store_id) REFERENCES agm_stores (id),
  FOREIGN KEY(created_by_user_id) REFERENCES users (id)
);

CREATE TABLE agm_store_memberships (
  id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  access_role VARCHAR(20) NOT NULL,
  active BOOLEAN NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_agm_store_membership UNIQUE (store_id, user_id),
  FOREIGN KEY(store_id) REFERENCES agm_stores (id),
  FOREIGN KEY(user_id) REFERENCES users (id)
);

CREATE TABLE agm_services (
  id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  layout_id INTEGER NOT NULL,
  service_date DATE NOT NULL,
  name VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL,
  starts_at VARCHAR(10),
  ends_at VARCHAR(10),
  revision INTEGER NOT NULL,
  opened_by_user_id INTEGER NOT NULL,
  closed_at DATETIME,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_agm_store_service UNIQUE (store_id, service_date, name),
  FOREIGN KEY(store_id) REFERENCES agm_stores (id),
  FOREIGN KEY(layout_id) REFERENCES agm_layouts (id),
  FOREIGN KEY(opened_by_user_id) REFERENCES users (id)
);

CREATE TABLE agm_table_definitions (
  id INTEGER NOT NULL,
  layout_id INTEGER NOT NULL,
  table_number VARCHAR(20) NOT NULL,
  label VARCHAR(60) NOT NULL,
  capacity INTEGER NOT NULL,
  shape VARCHAR(20) NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  rotation INTEGER NOT NULL,
  area_name VARCHAR(80),
  section_name VARCHAR(80),
  combinable_with JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_agm_layout_table_number UNIQUE (layout_id, table_number),
  FOREIGN KEY(layout_id) REFERENCES agm_layouts (id)
);

CREATE TABLE agm_events (
  id INTEGER NOT NULL,
  service_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  command_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  payload JSON,
  actor_user_id INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_agm_service_command UNIQUE (service_id, command_id),
  FOREIGN KEY(service_id) REFERENCES agm_services (id),
  FOREIGN KEY(actor_user_id) REFERENCES users (id)
);

CREATE TABLE agm_parties (
  id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  service_id INTEGER,
  source VARCHAR(20) NOT NULL,
  status VARCHAR(24) NOT NULL,
  guest_name VARCHAR(120) NOT NULL,
  phone VARCHAR(32),
  party_size INTEGER NOT NULL,
  reservation_at DATETIME,
  quoted_minutes INTEGER,
  notes TEXT,
  sms_consent BOOLEAN NOT NULL,
  table_numbers JSON,
  server_employee_id INTEGER,
  dining_stage VARCHAR(30),
  seated_at DATETIME,
  cleared_at DATETIME,
  revision INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(store_id) REFERENCES agm_stores (id),
  FOREIGN KEY(service_id) REFERENCES agm_services (id),
  FOREIGN KEY(server_employee_id) REFERENCES employees (id)
);

CREATE TABLE agm_server_rotations (
  id INTEGER NOT NULL,
  service_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  section_name VARCHAR(80),
  paused BOOLEAN NOT NULL,
  turns INTEGER NOT NULL,
  covers INTEGER NOT NULL,
  last_sat_at DATETIME,
  rotation_index INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_agm_service_server UNIQUE (service_id, employee_id),
  FOREIGN KEY(service_id) REFERENCES agm_services (id),
  FOREIGN KEY(employee_id) REFERENCES employees (id)
);

CREATE TABLE agm_sms_outbox (
  id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  party_id INTEGER NOT NULL,
  template_key VARCHAR(40) NOT NULL,
  recipient_phone VARCHAR(32) NOT NULL,
  body VARCHAR(480) NOT NULL,
  status VARCHAR(24) NOT NULL,
  provider_message_id VARCHAR(120),
  error_detail VARCHAR(255),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(store_id) REFERENCES agm_stores (id),
  FOREIGN KEY(party_id) REFERENCES agm_parties (id)
);

CREATE TABLE agm_table_states (
  id INTEGER NOT NULL,
  service_id INTEGER NOT NULL,
  table_number VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  party_id INTEGER,
  revision INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_agm_service_table_state UNIQUE (service_id, table_number),
  FOREIGN KEY(service_id) REFERENCES agm_services (id),
  FOREIGN KEY(party_id) REFERENCES agm_parties (id)
);

CREATE UNIQUE INDEX ix_agm_stores_store_number ON agm_stores (store_number);
CREATE INDEX ix_agm_layouts_status ON agm_layouts (status);
CREATE INDEX ix_agm_layouts_store_id ON agm_layouts (store_id);
CREATE INDEX ix_agm_store_memberships_store_id ON agm_store_memberships (store_id);
CREATE INDEX ix_agm_store_memberships_user_id ON agm_store_memberships (user_id);
CREATE INDEX ix_agm_services_service_date ON agm_services (service_date);
CREATE INDEX ix_agm_services_status ON agm_services (status);
CREATE INDEX ix_agm_services_store_id ON agm_services (store_id);
CREATE INDEX ix_agm_table_definitions_layout_id ON agm_table_definitions (layout_id);
CREATE INDEX ix_agm_events_event_type ON agm_events (event_type);
CREATE INDEX ix_agm_events_service_id ON agm_events (service_id);
CREATE INDEX ix_agm_parties_service_id ON agm_parties (service_id);
CREATE INDEX ix_agm_parties_source ON agm_parties (source);
CREATE INDEX ix_agm_parties_status ON agm_parties (status);
CREATE INDEX ix_agm_parties_store_id ON agm_parties (store_id);
CREATE INDEX ix_agm_server_rotations_service_id ON agm_server_rotations (service_id);
CREATE INDEX ix_agm_sms_outbox_party_id ON agm_sms_outbox (party_id);
CREATE INDEX ix_agm_sms_outbox_store_id ON agm_sms_outbox (store_id);
CREATE INDEX ix_agm_table_states_service_id ON agm_table_states (service_id);
CREATE INDEX ix_agm_table_states_status ON agm_table_states (status);

INSERT INTO agm_stores
  (store_number, name, timezone, active, created_at, updated_at)
SELECT '1', 'Restaurant 1', 'America/Chicago', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM agm_stores WHERE store_number = '1');

INSERT INTO agm_store_memberships
  (store_id, user_id, access_role, active, created_at, updated_at)
SELECT s.id, u.id, CASE WHEN u.role = 'ADMIN' THEN 'ADMIN' ELSE 'AGM' END,
  1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM users u CROSS JOIN agm_stores s
WHERE s.store_number = '1' AND u.role IN ('ADMIN', 'MANAGER');
