-- ============================================================================
-- ApnaKhata — Migration 009: Offline-first sync (grow-only CRDT log)
-- Depends on: migrations/008_customers_voice.sql
--
-- Connectivity is patchy, so the app must capture entries offline and reconcile
-- later. The customer khata is append-only: every entry is an immutable fact
-- identified by a client-generated op_id. Merging two devices' logs is a
-- set-union — idempotent, commutative, associative — a grow-only-set CRDT, so
-- no conflict resolution is needed. Balances are a fold over the merged set.
--
-- This migration adds:
--   • a global sync sequence (server_seq) on the synced tables, so a device can
--     pull everything newer than its last cursor;
--   • client_operations, the dedup ledger that makes replay idempotent.
-- ============================================================================

BEGIN;

-- One monotonic sequence shared across all synced tables => a single cursor.
CREATE SEQUENCE sync_seq;

ALTER TABLE customers
    ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('sync_seq');
ALTER TABLE customer_ledger_entries
    ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('sync_seq');

-- Pull deltas efficiently, scoped to the owner.
CREATE INDEX idx_customers_sync         ON customers (owner_id, server_seq);
CREATE INDEX idx_customer_entries_sync  ON customer_ledger_entries (owner_id, server_seq);

-- The applied-operations set. A push that replays an op_id already present is a
-- no-op that returns the original result — the idempotency guarantee that makes
-- an at-least-once client outbox safe.
CREATE TABLE client_operations (
    op_id       UUID PRIMARY KEY,                       -- client-generated dedup key
    owner_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id   VARCHAR(64) NOT NULL,
    op_type     VARCHAR(48) NOT NULL,                   -- CUSTOMER_LEDGER_ENTRY | …
    result_ref  UUID,                                   -- id of the row the op created
    client_ts   TIMESTAMPTZ,                            -- when the client captured it
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_client_ops_owner ON client_operations (owner_id, applied_at DESC);

COMMIT;
