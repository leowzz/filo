-- Photography has its own durable journal, independent of the 200-job history.
-- A versioned snapshot commits a plan and all its logical relationships together.
CREATE TABLE photo_catalog (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    document TEXT NOT NULL
);
INSERT INTO photo_catalog (id, document) VALUES (1, '{}');
