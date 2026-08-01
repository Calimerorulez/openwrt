PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS metadata (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    parent_id           INTEGER REFERENCES categories(id)
                                ON UPDATE CASCADE
                                ON DELETE SET NULL,
    display_name        TEXT NOT NULL,
    description         TEXT,
    source              TEXT NOT NULL DEFAULT 'builtin',
    enabled             INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    visible             INTEGER NOT NULL DEFAULT 1
                                CHECK (visible IN (0, 1)),
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_categories_parent
    ON categories(parent_id);

CREATE TABLE IF NOT EXISTS category_aliases (
    alias               TEXT PRIMARY KEY,
    category_id         INTEGER NOT NULL REFERENCES categories(id)
                                ON UPDATE CASCADE
                                ON DELETE CASCADE,
    source              TEXT NOT NULL DEFAULT 'builtin',
    created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS domains (
    id                  INTEGER PRIMARY KEY,
    domain              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    registrable_domain  TEXT COLLATE NOCASE,
    category_id         INTEGER REFERENCES categories(id)
                                ON UPDATE CASCADE
                                ON DELETE SET NULL,
    confidence          REAL CHECK (
                            confidence IS NULL OR
                            (confidence >= 0.0 AND confidence <= 1.0)
                        ),
    classification_source TEXT NOT NULL DEFAULT 'unknown',
    classification_status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (
                            classification_status IN (
                                'pending',
                                'classified',
                                'proposed',
                                'manual',
                                'ignored',
                                'failed'
                            )
                        ),
    first_seen          INTEGER NOT NULL,
    last_seen           INTEGER NOT NULL,
    query_count         INTEGER NOT NULL DEFAULT 0
                                CHECK (query_count >= 0),
    last_classified_at  INTEGER,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_domains_category
    ON domains(category_id);

CREATE INDEX IF NOT EXISTS idx_domains_status
    ON domains(classification_status);

CREATE INDEX IF NOT EXISTS idx_domains_last_seen
    ON domains(last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_domains_query_count
    ON domains(query_count DESC);

CREATE TABLE IF NOT EXISTS domain_aliases (
    alias_domain        TEXT PRIMARY KEY COLLATE NOCASE,
    canonical_domain_id INTEGER NOT NULL REFERENCES domains(id)
                                ON UPDATE CASCADE
                                ON DELETE CASCADE,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_domain_aliases_canonical
    ON domain_aliases(canonical_domain_id);

CREATE TABLE IF NOT EXISTS daily_domain_counts (
    day                 TEXT NOT NULL,
    domain_id           INTEGER NOT NULL REFERENCES domains(id)
                                ON UPDATE CASCADE
                                ON DELETE CASCADE,
    query_count         INTEGER NOT NULL DEFAULT 0
                                CHECK (query_count >= 0),
    first_seen          INTEGER NOT NULL,
    last_seen           INTEGER NOT NULL,
    PRIMARY KEY (day, domain_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_domain_counts_day_count
    ON daily_domain_counts(day, query_count DESC);

CREATE TABLE IF NOT EXISTS daily_category_counts (
    day                 TEXT NOT NULL,
    category_id         INTEGER REFERENCES categories(id)
                                ON UPDATE CASCADE
                                ON DELETE CASCADE,
    category_name       TEXT NOT NULL,
    query_count         INTEGER NOT NULL DEFAULT 0
                                CHECK (query_count >= 0),
    PRIMARY KEY (day, category_name)
);

CREATE INDEX IF NOT EXISTS idx_daily_category_counts_day_count
    ON daily_category_counts(day, query_count DESC);

CREATE TABLE IF NOT EXISTS classification_queue (
    domain_id           INTEGER PRIMARY KEY REFERENCES domains(id)
                                ON UPDATE CASCADE
                                ON DELETE CASCADE,
    priority            INTEGER NOT NULL DEFAULT 0,
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     INTEGER NOT NULL DEFAULT 0,
    queued_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    last_error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_classification_queue_ready
    ON classification_queue(next_attempt_at, priority DESC, queued_at);

CREATE TABLE IF NOT EXISTS ai_classifications (
    id                  INTEGER PRIMARY KEY,
    domain_id           INTEGER NOT NULL REFERENCES domains(id)
                                ON UPDATE CASCADE
                                ON DELETE CASCADE,
    model               TEXT NOT NULL,
    prompt_version      TEXT NOT NULL,
    proposed_category   TEXT NOT NULL,
    resolved_category_id INTEGER REFERENCES categories(id)
                                ON UPDATE CASCADE
                                ON DELETE SET NULL,
    confidence          REAL NOT NULL CHECK (
                            confidence >= 0.0 AND confidence <= 1.0
                        ),
    reasoning           TEXT,
    raw_response        TEXT,
    accepted            INTEGER NOT NULL DEFAULT 0
                                CHECK (accepted IN (0, 1)),
    created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ai_classifications_domain
    ON ai_classifications(domain_id, created_at DESC);

CREATE TABLE IF NOT EXISTS category_proposals (
    id                  INTEGER PRIMARY KEY,
    proposed_name       TEXT NOT NULL,
    normalized_name     TEXT NOT NULL UNIQUE,
    parent_name         TEXT,
    domain_count        INTEGER NOT NULL DEFAULT 0,
    confidence_sum      REAL NOT NULL DEFAULT 0.0,
    first_seen          INTEGER NOT NULL,
    last_seen           INTEGER NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (
                            status IN (
                                'pending',
                                'approved',
                                'rejected',
                                'merged'
                            )
                        ),
    merged_category_id  INTEGER REFERENCES categories(id)
                                ON UPDATE CASCADE
                                ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_category_proposals_status
    ON category_proposals(status, domain_count DESC);

INSERT INTO metadata(key, value)
VALUES
    ('schema_version', '1'),
    ('application_version', '2.0.0-alpha3')
ON CONFLICT(key) DO UPDATE SET
    value = excluded.value;

CREATE TABLE IF NOT EXISTS domain_rules (
    pattern             TEXT NOT NULL COLLATE NOCASE,
    match_type          TEXT NOT NULL DEFAULT 'suffix'
                                CHECK (match_type IN ('exact', 'suffix')),
    category_id         INTEGER NOT NULL REFERENCES categories(id)
                                ON UPDATE CASCADE
                                ON DELETE CASCADE,
    source              TEXT NOT NULL DEFAULT 'builtin',
    priority            INTEGER NOT NULL DEFAULT 100,
    enabled             INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (pattern, match_type, source)
);

CREATE INDEX IF NOT EXISTS idx_domain_rules_category
    ON domain_rules(category_id);

CREATE INDEX IF NOT EXISTS idx_domain_rules_matching
    ON domain_rules(enabled, priority, match_type, pattern);

CREATE TABLE IF NOT EXISTS current_cycle_counts (
    category_name       TEXT PRIMARY KEY,
    query_count         INTEGER NOT NULL DEFAULT 0
                                CHECK (query_count >= 0)
);

INSERT INTO categories
(
    name,
    display_name,
    description,
    source,
    enabled,
    visible
)
VALUES
(
    'unknown',
    'Onbekend',
    'Nog niet geclassificeerde domeinen',
    'system',
    1,
    1
)
ON CONFLICT(name) DO NOTHING;

INSERT INTO metadata(key, value)
VALUES ('schema_version', '3')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

INSERT INTO metadata(key, value)
VALUES ('application_version', '2.1.1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
