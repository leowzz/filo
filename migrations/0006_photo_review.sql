-- Review can open any existing library and never depends on an import journal.
CREATE TABLE photo_review_catalog (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    document TEXT NOT NULL
);
INSERT INTO photo_review_catalog (id, document) VALUES (1, '{}');
