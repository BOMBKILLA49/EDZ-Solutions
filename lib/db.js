const { Pool } = require("pg");

// Heroku sets DATABASE_URL and needs SSL; locally it's the plain "edz" database.
const connectionString = process.env.DATABASE_URL || "postgres://localhost/edz";
const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id               uuid PRIMARY KEY,
      created_at       timestamptz NOT NULL DEFAULT now(),
      paid_at          timestamptz,
      status           text NOT NULL DEFAULT 'pending_payment',
      stripe_session   text UNIQUE,
      details          jsonb NOT NULL,
      thickness        text NOT NULL,
      finish           text NOT NULL,
      qty              integer NOT NULL,
      total_cents      integer NOT NULL,
      watch_live       boolean NOT NULL DEFAULT false,
      tiktok           text,
      notes            text,
      design_type      text NOT NULL,
      svg              text,
      upload_name      text,
      upload_mime      text,
      upload_data      bytea,
      customer_email   text,
      customer_name    text,
      customer_phone   text,
      shipping         jsonb
    );
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, created_at);

    -- AI designs customers generate. Ordered designs are copied onto the order,
    -- so these are only kept for a while.
    CREATE TABLE IF NOT EXISTS designs (
      id          uuid PRIMARY KEY,
      created_at  timestamptz NOT NULL DEFAULT now(),
      prompt      text,
      image       bytea NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inquiries (
      id          serial PRIMARY KEY,
      created_at  timestamptz NOT NULL DEFAULT now(),
      data        jsonb NOT NULL
    );
  `);
  await pool.query("DELETE FROM designs WHERE created_at < now() - interval '30 days'");
}

module.exports = { pool, migrate };
