// Reads the outreach mailboxes (read only: nothing is marked read, moved or deleted) and
// updates prospects:
//   - a delivery-failure notice for an address we emailed → bounced
//   - a reply from a business we emailed (its address, or our subject line) → replied
// Out-of-office auto replies are ignored. Unsubscribing only happens through the link.
// Each folder remembers the last message it checked (inbox_state), so a message is read once.

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const outreach = require("./outreach");

const FOLDERS = ["INBOX", "Spam", "Junk"];
const LOCK_ID = 424243; // so only one server process checks at a time

const BOUNCE_SUBJECT = /delivery status notification|undeliver|delivery (has )?failed|mail delivery (failed|subsystem)|returned mail|failure notice|could not be delivered|delivery failure/i;
const AUTO_SUBJECT = /out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|vacation|away from (the )?office/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

async function handleBounce(pool, box, mail) {
  // The notice text plus its machine-readable delivery-status part, when there is one.
  const parts = [mail.text || "", ...(mail.attachments || []).filter((a) => /delivery-status|rfc822|text\//i.test(a.contentType)).map((a) => a.content.toString("utf8"))].join("\n");
  const recipients = new Set([...parts.matchAll(/(?:final|original)-recipient:\s*rfc822;\s*<?([^\s>;]+)/gi)].map((m) => m[1].toLowerCase()));
  if (!recipients.size) for (const m of parts.matchAll(EMAIL_RE)) recipients.add(m[0].toLowerCase());
  const reason = (/diagnostic-code:\s*(?:smtp;\s*)?(.+)/i.exec(parts) || [])[1] || mail.subject || "delivery failed";
  // Only addresses this mailbox actually emailed count (a notice also mentions our own address).
  const { rows } = await pool.query(
    `UPDATE prospects SET status='bounced', notes=$3
     WHERE lower(email) = ANY($1) AND sent_from=$2 AND status IN ('sent', 'replied')
     RETURNING email`,
    [[...recipients], box.user, `Bounced: ${reason}`.slice(0, 300)]
  );
  return rows.map((r) => ({ kind: "bounced", email: r.email }));
}

async function handleReply(pool, box, mail) {
  const from = (mail.from?.value?.[0]?.address || "").toLowerCase();
  if (!from || from === box.user) return [];
  const auto = String(mail.headers.get("auto-submitted") || "no").toLowerCase();
  if (auto !== "no" || AUTO_SUBJECT.test(mail.subject || "") || mail.headers.get("x-autoreply") || mail.headers.get("x-autorespond")) return [];
  const subject = mail.subject || "(no subject)";
  const first = String(mail.text || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith(">")) || "";
  const note = `Replied ${new Date(mail.date || Date.now()).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: "${subject}"${first ? ` — ${first}` : ""}`.slice(0, 300);
  // Their address first; otherwise the owner may have answered from another address, so match
  // the business name in a reply to our subject ("Re: I made a new homepage for ...").
  let { rows } = await pool.query(
    "UPDATE prospects SET status='replied', notes=$3 WHERE lower(email)=$1 AND sent_from=$2 AND status='sent' RETURNING email",
    [from, box.user, note]
  );
  if (!rows[0] && /(new homepage|website) for /i.test(subject)) {
    ({ rows } = await pool.query(
      `UPDATE prospects SET status='replied', notes=$3 WHERE id = (
         SELECT id FROM prospects WHERE sent_from=$1 AND status='sent' AND position(lower(data->>'business') in lower($2)) > 0
         ORDER BY sent_at DESC LIMIT 1
       ) RETURNING email`,
      [box.user, subject, note]
    ));
  }
  return rows.map((r) => ({ kind: "replied", email: r.email }));
}

async function checkFolder(pool, client, box, folder) {
  let lock;
  try {
    lock = await client.getMailboxLock(folder, { readOnly: true });
  } catch {
    return []; // this mailbox has no such folder
  }
  const found = [];
  try {
    const key = `${box.user}|${folder}`;
    const uidValidity = String(client.mailbox.uidValidity);
    const state = (await pool.query("SELECT uidvalidity, last_uid FROM inbox_state WHERE mailbox=$1", [key])).rows[0];
    const start = state && state.uidvalidity === uidValidity ? Number(state.last_uid) + 1 : 1;
    let last = start - 1;
    if (client.mailbox.exists) {
      for await (const msg of client.fetch(`${start}:*`, { uid: true, source: true, size: true }, { uid: true })) {
        if (msg.uid < start) continue; // "n:*" returns the newest message even when it's older than n
        last = Math.max(last, msg.uid);
        if (msg.size > 3 * 1024 * 1024) continue;
        const mail = await simpleParser(msg.source);
        const from = (mail.from?.value?.[0]?.address || "").toLowerCase();
        const bounce = /mailer-daemon|postmaster/.test(from) || BOUNCE_SUBJECT.test(mail.subject || "") || /multipart\/report/i.test(String(mail.headers.get("content-type")?.value || ""));
        found.push(...(bounce ? await handleBounce(pool, box, mail) : await handleReply(pool, box, mail)));
      }
    }
    await pool.query(
      `INSERT INTO inbox_state (mailbox, uidvalidity, last_uid, checked_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (mailbox) DO UPDATE SET uidvalidity=$2, last_uid=$3, checked_at=now()`,
      [key, uidValidity, last]
    );
  } finally {
    lock.release();
  }
  return found;
}

async function checkMailbox(pool, box) {
  const client = new ImapFlow({
    host: process.env.OUTREACH_IMAP_HOST || process.env.OUTREACH_SMTP_HOST,
    port: Number(process.env.OUTREACH_IMAP_PORT || 993),
    secure: true,
    auth: { user: box.user, pass: box.pass },
    logger: false,
  });
  await client.connect();
  try {
    const found = [];
    for (const folder of FOLDERS) found.push(...(await checkFolder(pool, client, box, folder)));
    return found;
  } finally {
    await client.logout().catch(() => {});
  }
}

// Checks every outreach mailbox. Returns what changed, e.g. [{ kind: "replied", email }].
async function checkAll(pool) {
  if (outreach.notReady()) return [];
  const lock = await pool.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID]);
  if (!lock.rows[0].ok) return [];
  const found = [];
  try {
    for (const box of outreach.mailboxes()) {
      try {
        found.push(...(await checkMailbox(pool, box)));
      } catch (err) {
        console.error(`inbox check for ${box.user} failed:`, err.message);
      }
    }
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
  }
  for (const f of found) console.log(`inbox: ${f.kind} ${f.email}`);
  return found;
}

module.exports = { checkAll };
