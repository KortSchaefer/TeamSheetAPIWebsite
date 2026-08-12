-- Track private R2 voice-audio objects without storing object bodies in D1.
CREATE TABLE inventory_voice_audio_objects (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id INTEGER NOT NULL,
	upload_id VARCHAR(36) NOT NULL,
	object_key VARCHAR(500) NOT NULL,
	content_type VARCHAR(100) NOT NULL,
	original_filename VARCHAR(150) NOT NULL,
	byte_size INTEGER,
	etag VARCHAR(128),
	status VARCHAR(10) NOT NULL DEFAULT 'PENDING'
		CHECK (status IN ('PENDING', 'STORED', 'DELETED', 'MISSING')),
	upload_expires_at DATETIME NOT NULL,
	stored_at DATETIME,
	deleted_at DATETIME,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	CONSTRAINT uq_voice_audio_session_upload UNIQUE (session_id, upload_id),
	CONSTRAINT uq_voice_audio_object_key UNIQUE (object_key),
	FOREIGN KEY(session_id) REFERENCES inventory_voice_sessions (id)
);

CREATE INDEX ix_inventory_voice_audio_objects_session_id
	ON inventory_voice_audio_objects (session_id);

CREATE INDEX ix_inventory_voice_audio_objects_status
	ON inventory_voice_audio_objects (status);
