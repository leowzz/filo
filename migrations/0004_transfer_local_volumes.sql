-- Kept separately from sidebar volumes; only completed transfer actions resolve these.
CREATE TABLE transfer_local_volumes (
    id TEXT PRIMARY KEY,
    volume_json TEXT NOT NULL
);
