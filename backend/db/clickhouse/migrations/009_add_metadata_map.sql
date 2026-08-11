-- +goose Up
-- Make user metadata queryable without giving up the raw blob.
--
-- `metadata` is an opaque Nullable(String) JSON document on both tables: nothing
-- can filter it without a full scan and a per-row JSON parse, and it is
-- deliberately absent from the no-I/O projection (added in 005, respecified by
-- 008) so the unfiltered trace list never pays to read it. `metadata_map` is the
-- queryable projection of that same document — one level deep, values
-- stringified — so a metadata predicate becomes `metadata_map[key] = value` over a
-- small Map column instead of a JSON parse over a ZSTD blob.
--
-- MATERIALIZED gives one implementation. An INSERT may not name a materialized column, so
-- ingestion cannot write a value of its own and a second implementation is
-- unrepresentable. It also removes a deploy-ordering trap: an explicit INSERT column
-- list naming `metadata_map` would fail ALL ingestion whenever the worker ships ahead of
-- this migration, and there is now no column list that could name it. MATERIALIZED also
-- leaves `SELECT *` as it was -- materialized columns are excluded from it -- so no
-- existing star query starts reading user metadata by accident.
--
-- This file ADDs the columns and nothing else. The ADDs are metadata-only: no part is
-- rewritten, so they are safe on the migration path. Making EXISTING history answer
-- metadata questions takes a second, much heavier step -- rewriting pre-ALTER parts so
-- they store the map -- which lives in 010_materialize_metadata_map.sql. That file is on the
-- migration path too, and runs on every deploy; 010 documents what that costs.
-- 010 is REQUIRED, not an optimization: through the read shape we ship, a pre-ALTER part
-- returns an EMPTY map rather than a computed one, silently. 010 documents why, with the
-- verification, and how it differs from 008's deliberate refusal to materialize.
--
-- Applying 009 alone is a complete, safe deploy: ingestion is unchanged and every
-- metadata surface (filter, column, key discovery) answers correctly over data ingested
-- from here on. Only history stays blank until 010 runs.
--
-- The no-I/O projection is untouched on purpose, but be precise about why, because the
-- tempting justification is wrong. Including metadata_map would NOT put user metadata back
-- on the path of the unfiltered list query: a projection is a separate set of parts with its
-- own columns, and a query reads only the columns it references, so a column the list query
-- never names costs it nothing to read. The real cost of including it is storage and write
-- amplification -- one more column materialised into every projection part and rewritten on
-- every merge, on the largest table we have. That is the tradeoff being made here, and it is
-- a defensible one to make before any measurement exists; comparable designs draw the line
-- differently and exclude only the input/output blobs.
--
-- The price of leaving it out is real and is exactly the regression 008 exists to fix. By
-- 008's own rule -- a projection can only serve a query whose referenced columns it ALL
-- carries -- excluding metadata_map disqualifies EVERY span-scope metadata predicate from
-- spans_no_io_by_start_time and drops it to the base table. metadata_map is the only column
-- that scan reads which the projection lacks; everything else it touches (project_id,
-- trace_id, span_id, span_start_time, ch_update_time) is already there. So the known
-- follow-up, if the fallback turns out to hurt, is shaped exactly like 008: DROP + ADD the
-- projection with metadata_map in the column list and deliberately OUT of its ORDER BY. It
-- wants what 008 had before it shipped -- a measurement of the query it is meant to help --
-- which is why it is a follow-up and not this file.

-- The rule the expression below implements, in the order it is applied:
--   1. Missing, empty, non-JSON, or non-object metadata yields an empty map --
--      JSONExtractKeysAndValuesRaw returns an empty array for all four.
--   2. Keys prefixed `traceroot.` are dropped: the whole namespace is ours, not the
--      user's. It covers span routing attributes (traceroot.span.path,
--      traceroot.span.ids_path) and SDK identity (traceroot.sdk.name,
--      traceroot.sdk.version), all of which fall into the blob at ingest. They are on
--      nearly every span, so left in they outrank every real user key in the
--      frequency-ordered key list and crowd out the keys someone would filter on.
--   3. A JSON string value is stored unquoted and unescaped; every other value
--      (number, bool, null, nested object, array) is stored as its raw JSON text,
--      spelled the way ClickHouse's JSON parser re-emits it. Keys are one level
--      deep -- nested path addressing is out of scope, so a nested object is a
--      single opaque string value.
ALTER TABLE spans
    ADD COLUMN IF NOT EXISTS metadata_map Map(LowCardinality(String), String)
    MATERIALIZED CAST(
        arrayMap(
            kv -> (
                tupleElement(kv, 1),
                if(
                    startsWith(tupleElement(kv, 2), '"'),
                    JSONExtractString(tupleElement(kv, 2)),
                    tupleElement(kv, 2)
                )
            ),
            arrayFilter(
                kv -> NOT startsWith(tupleElement(kv, 1), 'traceroot.'),
                JSONExtractKeysAndValuesRaw(ifNull(metadata, ''))
            )
        ),
        'Map(LowCardinality(String), String)'
    );

-- Same column, same expression, on traces. One expression for both tables is what lets
-- a column and a filter agree on what a key is called and what its value looks like.
ALTER TABLE traces
    ADD COLUMN IF NOT EXISTS metadata_map Map(LowCardinality(String), String)
    MATERIALIZED CAST(
        arrayMap(
            kv -> (
                tupleElement(kv, 1),
                if(
                    startsWith(tupleElement(kv, 2), '"'),
                    JSONExtractString(tupleElement(kv, 2)),
                    tupleElement(kv, 2)
                )
            ),
            arrayFilter(
                kv -> NOT startsWith(tupleElement(kv, 1), 'traceroot.'),
                JSONExtractKeysAndValuesRaw(ifNull(metadata, ''))
            )
        ),
        'Map(LowCardinality(String), String)'
    );

-- No skip index on metadata_map, on either table -- DEFERRED, not ruled out. A bloom filter
-- over mapKeys(metadata_map) is the obvious fit, and it is the standard remedy in mature
-- OTel backends, several of which ship one by default for exactly this column shape. Two
-- things are true at once: the query as we write it today cannot consult such an index, and
-- the restructuring that would make it live is understood and sketched below. We are
-- deferring the index AND the restructure until a measurement says which is worth having,
-- because an index nobody reads is write amplification on every part -- not because they
-- cannot work.
--
-- Why an index is inert for the query shape we ship today:
--   * The predicate FORM is already the right one, which is worth knowing before anyone
--     goes looking for the usual trap. `_keyed_map_match` emits
--     `mapContains(metadata_map, key) AND metadata_map[key] OP value`. That explicit
--     key-membership conjunct is precisely what makes a mapKeys bloom filter actionable:
--     an index analyzer cannot extract a key-membership test out of a bare subscript
--     comparison on its own, and we already emit the conjunct that hands it one.
--   * What blocks it is POSITION, not form. That conjunct sits in the OUTER WHERE, above
--     the `LIMIT 1 BY project_id, trace_id, span_id` that dedups the ReplacingMergeTree to
--     the latest version of each span. That order is required for correctness -- predicate
--     first would match a superseded map -- and ClickHouse does not push a predicate
--     through LIMIT BY, so granule selection happens for the dedup, before the predicate
--     exists. An index would be maintained on write and never once consulted.
--   * Key discovery has no key predicate at all: it arrayJoins mapKeys over the whole
--     window to enumerate what exists, so there is nothing to prune by. No index shape
--     helps that one, and none is claimed to.
--
-- The restructure that WOULD make an index live, written down so the next person does not
-- have to rediscover it. Prefilter candidate spans with a plain, index-eligible scan on the
-- base table -- `WHERE project_id = ... AND <the same time bound> AND
-- mapContains(metadata_map, key) AND metadata_map[key] OP value`, with no LIMIT BY above it,
-- so granule selection sees the conjunct -- then run the EXISTING deduped scan restricted to
-- the resulting (project_id, trace_id, span_id) triples and re-apply the predicate to its
-- output. Correctness holds on two observations. The candidate set is a SUPERSET of the true
-- matches: if the latest version of a span matches, that version is itself a row matching the
-- prefilter, so its triple is collected. And restricting the deduped scan by whole triples
-- cannot change which row wins within a group, because the triple IS the LIMIT BY key -- the
-- restriction selects whole groups, never rows inside one. The re-check on the deduped output
-- is what discards the candidates whose only match lives on a superseded version. What is
-- unmeasured is whether the prefilter is selective enough to earn a second scan; on a
-- high-frequency key it plainly would not be.
--
-- The trace-level half needs none of that: it is an inline predicate on the traces scan with
-- no LIMIT BY between it and the granules, so an index there would be consulted as written
-- today. It still gets none, because traces is the small table, already pruned by the monthly
-- partition and the sort key. Note what is NOT a reason: "an index would only cover parts
-- written from here on" is false as soon as 010 lands, which it does immediately after this
-- file. `MATERIALIZE COLUMN` plus a `MATERIALIZE INDEX` backfills existing parts the same
-- way, and reference implementations ship both in a single migration.
--
-- Next step for whoever picks this up: benchmark the restructured span query against the
-- current one at realistic key cardinality FIRST, and add the index only if that measurement
-- says the prefilter pays. This is an open question, not a closed one.

-- +goose Down
ALTER TABLE spans  DROP COLUMN IF EXISTS metadata_map;
ALTER TABLE traces DROP COLUMN IF EXISTS metadata_map;
