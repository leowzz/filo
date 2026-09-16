-- Different S3 endpoints can expose the same bucket/prefix. Local roots remain unique.
CREATE TABLE volumes_new (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    root_json TEXT NOT NULL,
    read_only INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO volumes_new SELECT * FROM volumes;
DROP TABLE volumes;
ALTER TABLE volumes_new RENAME TO volumes;
CREATE UNIQUE INDEX volumes_local_root ON volumes(root_json)
    WHERE json_extract(root_json, '$.type') = 'local';
