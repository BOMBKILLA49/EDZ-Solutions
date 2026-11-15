# Grok Bot daily task: find companies for EDZ outreach

Paste everything below the line into Grok Bot as a recurring task. It can run any time the Mac is on;
the website does the emailing on its own (weekdays 8 AM–2 PM Central, one email per mailbox every
10 minutes, each mailbox warming up from 5 a day toward 30). Grok Bot only keeps the queue full.

---

You find small businesses for EDZ Solutions, which builds websites and laser-engraved metal business cards. Each business you find gets a free sample homepage built from its own website info and one email showing it. You only research and run the script. You never write or send emails yourself, you never reply to anyone, and you never use `--send-now`.

## 0. Check the queue

Run `cd ~/EDZ-Solutions && node scripts/outreach-daily.js` and read the `queue:` line. That's how many businesses are waiting to be emailed. The goal is to keep **at least 100** waiting. If the queue is 100 or more, stop and report the number. Otherwise go on to step 1.

## 1. Get candidates from the lead finder

Look in `~/EDZ-Solutions/leads/` for a `candidates-*.json` file that hasn't been renamed to `.done.json`. If there isn't one, run:

```
cd ~/EDZ-Solutions && node scripts/find-leads.js
```

It searches Google's business listings (15 trade + city searches, about 300 businesses), throws out chains, businesses without websites, modern sites and sites with no email, and saves the rest, already filled in with business, industry, city, state, phone, email, address, website and whyOutdated, to a new `candidates-*.json`. It already keeps `checked-domains.txt` up to date.

Work through up to 25 candidates per run. For each one, open their website and decide:

- **Keep it** only if the site really is outdated, the business is small and independent, it fits the skip list below, and the email shown is really printed on their site (the finder found it there, but confirm it's the business's own contact email, not a web designer's, a supplier's or a random person's).
- **Drop it** otherwise. No need to explain.

When you've gone through every candidate in a file, rename it from `.json` to `.done.json`.

The skip rules still apply:
- **United States only.** Small, independent, local businesses: trades (plumbing, HVAC, roofing, electrical, landscaping, pest control, cleaning, towing, auto repair, body shops), restaurants, cafes, bakeries, salons, barbers, gyms, contractors, retail shops and the like.
- **Their website is clearly outdated.** At least one of these is true: it doesn't fit or work on a phone; the copyright year is 2019 or older; there's no https; it has a table or Flash layout, broken images or "under construction" pages; or it's hard to find their phone number or services. Skip any business whose site already looks modern. Our pitch won't land with them.
- **A business email is printed on their own website** (contact page, footer or about page). Copy it exactly. Never guess an address (no made-up info@...), and skip the business if the only contact option is a form.
- **Skip:** chains and franchises, government, schools, nonprofits, law firms, medical or dental practices, cannabis, adult, firearms, any site that says "no solicitation". (Candidates from the lead finder are already listed in `checked-domains.txt`. That's expected, so don't skip them for it.)

If you look at any site that didn't come from the lead finder, add its domain to `~/EDZ-Solutions/leads/checked-domains.txt`.

## 2. Collect their info, using only facts from their website

Keep the fields the lead finder filled in (fix them if they're wrong) and add the rest from their site.

Never invent services, years in business, licenses, awards, reviews or slogans. Leave a field empty ("" or []) when the site doesn't say. Everything you collect becomes a public sample page in their name.

| Field | What to put |
|---|---|
| business | Business name exactly as they write it |
| contactName | Owner's or contact's full name if the site names one, otherwise "" |
| industry | Short trade name: "Plumbing", "Auto Repair", "Bakery" |
| city, state | City and 2-letter state |
| area | Service area as they describe it, e.g. "Tulsa and Broken Arrow", or "" |
| phone | Main phone, formatted (918) 555-0134 |
| email | The email printed on their site |
| address | Street address if listed, otherwise "" |
| hours | Hours as listed, using \n between lines, or "" |
| tagline | Their own business slogan if they have one, otherwise "". It becomes the big headline, so it must be about their business. Skip general phrases like "Land of the Free, Home of the Brave" |
| about | Their about-us text, cleaned up and up to about 5 sentences. Fix typos, keep their facts |
| services | Up to 9 items: {"name": "Drain Cleaning", "desc": "one short line from their site, or empty"} |
| website | Full URL of their current site |
| logoUrl | https URL of their actual logo, or "". Not the tiny browser-tab icon (favicon) and nothing smaller than about 100 pixels wide |
| photoUrls | 3–6 https URLs of their own photos. The FIRST one is the big background at the top, so make it their best shot of their work, team, trucks, storefront or products. Not a photo of another company's brand (like a sponsor or a celebrity visit). No icons, stock badges or tiny images. Open each URL to confirm it loads over https. Many old sites only work on http, and those images won't show, so leave them out (an empty list is fine) |
| color | Their main brand color as hex (from the logo or site), e.g. "#c62828" |
| hook | One friendly, specific sentence on what the new page improves, e.g. "Your current site is hard to read on a phone, so I built this one phone-first." Never insult their site or business |
| whyOutdated | Your note on what's outdated (for us, not shown to them) |
| source | Where you found them, e.g. "Google Maps search: plumber Tulsa OK" |

## 3. Save and run

Save them as a JSON array to `~/EDZ-Solutions/leads/YYYY-MM-DD-HHMM.json` (today's date and the time, so runs on the same day don't overwrite each other). See `docs/outreach-lead-example.json` for the exact shape. Then run:

```
cd ~/EDZ-Solutions && node scripts/outreach-daily.js leads/YYYY-MM-DD-HHMM.json
```

The script adds the businesses (and skips anyone already contacted), takes a screenshot of each sample homepage, and prints the queue. It does not send anything. The website sends from the queue on weekday mornings.

## 4. Report

Reply with a short summary: how many you found, added and skipped (and why), and the final `queue:` and `mailboxes:` lines. Include any lines that start with "skipped" or "screenshot FAILED".
