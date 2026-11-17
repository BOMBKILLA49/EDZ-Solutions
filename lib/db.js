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

    -- percent: value = % off; amount: value = cents off; fixed_total: value = order total in cents
    CREATE TABLE IF NOT EXISTS promos (
      code        text PRIMARY KEY,
      kind        text NOT NULL CHECK (kind IN ('percent', 'amount', 'fixed_total')),
      value       integer NOT NULL CHECK (value >= 0),
      active      boolean NOT NULL DEFAULT true,
      max_uses    integer,
      uses        integer NOT NULL DEFAULT 0,
      note        text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents integer NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS back_mode text NOT NULL DEFAULT 'none';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS back_name text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS back_mime text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS back_data bytea;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_url text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cents integer NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_dest text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_flag text;
    -- 'business' or 'wedding'. Wedding orders with a guest list get one card per name.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS product text NOT NULL DEFAULT 'business';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_names jsonb;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS name_font text;

    -- Website plan purchases.
    CREATE TABLE IF NOT EXISTS projects (
      id                  uuid PRIMARY KEY,
      created_at          timestamptz NOT NULL DEFAULT now(),
      paid_at             timestamptz,
      status              text NOT NULL DEFAULT 'pending_payment',
      plan                text NOT NULL,
      stripe_session      text UNIQUE,
      stripe_subscription text,
      stripe_customer     text,
      data                jsonb NOT NULL,
      logo_name           text,
      logo_mime           text,
      logo_data           bytea,
      customer_email      text,
      customer_name       text
    );

    -- Cold outreach: companies Grok Bot finds. Each gets a sample homepage at /p/<slug>
    -- and one email. Status: new (no screenshot yet) → ready → sent → replied / won,
    -- or unsubscribed / bounced / skipped. Emails and website domains are never emailed twice.
    CREATE TABLE IF NOT EXISTS prospects (
      id            uuid PRIMARY KEY,
      created_at    timestamptz NOT NULL DEFAULT now(),
      slug          text NOT NULL UNIQUE,
      email         text NOT NULL,
      domain        text,
      status        text NOT NULL DEFAULT 'new',
      data          jsonb NOT NULL,
      shot          bytea,
      sent_at       timestamptz,
      unsub_token   text NOT NULL UNIQUE,
      views         integer NOT NULL DEFAULT 0,
      last_view_at  timestamptz,
      notes         text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prospects_email_idx ON prospects (lower(email));
    CREATE UNIQUE INDEX IF NOT EXISTS prospects_domain_idx ON prospects (domain) WHERE domain IS NOT NULL;
    CREATE INDEX IF NOT EXISTS prospects_status_idx ON prospects (status, created_at);
    -- Which outreach mailbox sent it (mailboxes rotate and warm up separately).
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS sent_from text;
    -- Businesses with no email go on the call list (channel 'call') instead of the email queue.
    -- phone_key (last 10 digits) keeps a no-website business from being added twice.
    ALTER TABLE prospects ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS phone_key text;
    CREATE UNIQUE INDEX IF NOT EXISTS prospects_phone_idx ON prospects (phone_key) WHERE phone_key IS NOT NULL;
    -- message_id threads the follow-up under the first email; followup_at marks it sent.
    -- prev_status lets the admin undo the last status change.
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS message_id text;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS followup_at timestamptz;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS prev_status text;

    -- Promo limits: null means any. qty is an exact card count.
    ALTER TABLE promos ADD COLUMN IF NOT EXISTS product text;
    ALTER TABLE promos ADD COLUMN IF NOT EXISTS thickness text;
    ALTER TABLE promos ADD COLUMN IF NOT EXISTS finish text;
    ALTER TABLE promos ADD COLUMN IF NOT EXISTS qty integer;

    -- Customer accounts: there are no passwords. A 6-digit code is emailed to the address
    -- used at checkout, and a session cookie keeps them signed in. Orders link by email.
    CREATE TABLE IF NOT EXISTS login_codes (
      email       text PRIMARY KEY,
      code_hash   text NOT NULL,
      expires_at  timestamptz NOT NULL,
      attempts    integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  text PRIMARY KEY,
      email       text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (lower(customer_email));

    -- Do-not-contact list: when a finished prospect (skipped, bounced, unsubscribed) is deleted
    -- from the admin, its email, website domain and phone/Facebook key stay here so the
    -- lead finders never add it back (and an unsubscribe is honored forever).
    CREATE TABLE IF NOT EXISTS suppressions (
      key         text PRIMARY KEY,
      reason      text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    -- One AI stock photo per trade for sample homepages without the business's own photos.
    CREATE TABLE IF NOT EXISTS trade_images (
      key         text PRIMARY KEY,
      image       bytea NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    -- Where the outreach inbox checker left off, per "mailbox|folder".
    CREATE TABLE IF NOT EXISTS inbox_state (
      mailbox      text PRIMARY KEY,
      uidvalidity  text NOT NULL,
      last_uid     bigint NOT NULL DEFAULT 0,
      checked_at   timestamptz
    );

    CREATE TABLE IF NOT EXISTS inquiries (
      id          serial PRIMARY KEY,
      created_at  timestamptz NOT NULL DEFAULT now(),
      data        jsonb NOT NULL
    );
  `);
  await pool.query("DELETE FROM designs WHERE created_at < now() - interval '30 days'");
  await pool.query("DELETE FROM sessions WHERE expires_at < now()");
  await pool.query("DELETE FROM login_codes WHERE expires_at < now()");
}

module.exports = { pool, migrate };
