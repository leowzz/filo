CREATE TABLE transfer_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    upload_kib_per_second INTEGER NOT NULL DEFAULT 0 CHECK (upload_kib_per_second BETWEEN 0 AND 1048576),
    download_kib_per_second INTEGER NOT NULL DEFAULT 0 CHECK (download_kib_per_second BETWEEN 0 AND 1048576)
);
INSERT INTO transfer_settings (id) VALUES (1);
