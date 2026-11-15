#!/usr/bin/env node
// Finds outreach candidates fast, so Grok Bot only writes up good ones:
//   node scripts/find-leads.js                 run 15 Google searches (trade + city), about 300 businesses
//   node scripts/find-leads.js --searches 40   more searches this run
//
// For each business Google Places returns, it skips ones with no website, chains, sites
// already checked or contacted, and modern-looking sites; then it looks for an email printed
// on the site. Survivors are saved, pre-filled, to leads/candidates-YYYY-MM-DD-HHMM.json.
// Every domain looked at is added to leads/checked-domains.txt; every search to leads/searched.txt.
//
// Needs a Google Places API (New) key in ~/.config/edz/google_places_key (or GOOGLE_PLACES_KEY).
// Cost: each search is one Text Search Enterprise request (1,000 free a month, then $35 per 1,000).
// Google won't let a free-trial account lower its own daily quota, so this script stops itself at
// PLACES_MONTHLY_LIMIT searches a calendar month (default 900), counted in leads/places-usage.log.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LEADS = path.join(ROOT, "leads");
const SITE = (process.env.EDZ_URL || "https://www.edzsolutions.com").replace(/\/$/, "");
const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const KEY = (process.env.GOOGLE_PLACES_KEY || read(path.join(os.homedir(), ".config/edz/google_places_key"))).trim();
const PASSWORD = (process.env.EDZ_ADMIN_PASSWORD || read(path.join(os.homedir(), ".config/edz/admin_password"))).trim();
const argv = process.argv.slice(2);
const SEARCHES = Number(argv[argv.indexOf("--searches") + 1]) || 15;
const MONTHLY_LIMIT = Number(process.env.PLACES_MONTHLY_LIMIT) || 900;

// Trades we pitch (no law, medical, cannabis, firearms, nonprofits, government, schools).
const TRADES = [
  "plumber", "HVAC contractor", "roofing contractor", "electrician", "landscaping company", "pest control",
  "house cleaning service", "towing service", "auto repair shop", "auto body shop", "bakery", "cafe",
  "family restaurant", "hair salon", "barber shop", "fitness gym", "general contractor", "painting contractor",
  "flooring store", "garage door repair", "tree service", "fence contractor", "concrete contractor",
  "appliance repair", "locksmith", "carpet cleaning", "pool service", "septic service", "welding shop",
  "machine shop", "small engine repair", "upholstery shop", "florist", "pet grooming", "dog boarding kennel",
  "tire shop", "transmission repair", "glass repair", "sign shop", "printing shop", "jewelry store",
  "furniture store", "hardware store", "boat repair", "RV repair", "lawn mower repair", "moving company",
];

// Small and mid-size US cities, all regions. Searches rotate through trade × city pairs.
const CITIES = (`Tulsa OK|Wichita KS|Omaha NE|Des Moines IA|Springfield MO|Little Rock AR|Shreveport LA|Lafayette LA|Jackson MS|Mobile AL|Montgomery AL|Huntsville AL|Chattanooga TN|Knoxville TN|Lexington KY|Bowling Green KY|Evansville IN|Fort Wayne IN|Terre Haute IN|South Bend IN|Toledo OH|Dayton OH|Akron OH|Canton OH|Youngstown OH|Erie PA|Scranton PA|Allentown PA|Reading PA|Lancaster PA|Harrisburg PA|Syracuse NY|Rochester NY|Albany NY|Binghamton NY|Utica NY|Buffalo NY|Hartford CT|New Haven CT|Worcester MA|Springfield MA|Manchester NH|Portland ME|Burlington VT|Providence RI|Trenton NJ|Wilmington DE|Hagerstown MD|Roanoke VA|Lynchburg VA|Richmond VA|Charleston WV|Greensboro NC|Fayetteville NC|Wilmington NC|Asheville NC|Columbia SC|Greenville SC|Augusta GA|Macon GA|Savannah GA|Columbus GA|Tallahassee FL|Pensacola FL|Gainesville FL|Ocala FL|Lakeland FL|Fort Myers FL|Daytona Beach FL|Beaumont TX|Waco TX|Tyler TX|Lubbock TX|Amarillo TX|Abilene TX|Midland TX|Odessa TX|San Angelo TX|Corpus Christi TX|Laredo TX|Killeen TX|Wichita Falls TX|Lawton OK|Norman OK|Topeka KS|Lincoln NE|Sioux Falls SD|Rapid City SD|Fargo ND|Bismarck ND|Duluth MN|Rochester MN|St. Cloud MN|Eau Claire WI|Green Bay WI|Appleton WI|Rockford IL|Peoria IL|Springfield IL|Champaign IL|Joliet IL|Davenport IA|Cedar Rapids IA|Grand Rapids MI|Lansing MI|Kalamazoo MI|Flint MI|Saginaw MI|Billings MT|Missoula MT|Boise ID|Idaho Falls ID|Casper WY|Pueblo CO|Grand Junction CO|Colorado Springs CO|Ogden UT|Provo UT|St. George UT|Reno NV|Las Cruces NM|Farmington NM|Flagstaff AZ|Yuma AZ|Tucson AZ|Mesa AZ|Bakersfield CA|Fresno CA|Modesto CA|Stockton CA|Redding CA|Chico CA|Visalia CA|Salinas CA|Eugene OR|Medford OR|Salem OR|Bend OR|Spokane WA|Yakima WA|Tacoma WA|Kennewick WA|Anchorage AK|Hilo HI|`
  // Small towns: older websites are much more common here than in the cities above.
  + `Hobbs NM|Clovis NM|Roswell NM|Carlsbad NM|Alamogordo NM|Gallup NM|Silver City NM|Deming NM|Kingman AZ|Show Low AZ|Sierra Vista AZ|Prescott AZ|Elko NV|Fallon NV|Cedar City UT|Vernal UT|Rock Springs WY|Sheridan WY|Riverton WY|Gillette WY|Durango CO|Montrose CO|Sterling CO|Alamosa CO|Garden City KS|Hays KS|Salina KS|Dodge City KS|Liberal KS|Emporia KS|North Platte NE|Kearney NE|Grand Island NE|Scottsbluff NE|Norfolk NE|Mitchell SD|Aberdeen SD|Watertown SD|Minot ND|Dickinson ND|Williston ND|Jamestown ND|Bemidji MN|Brainerd MN|Mankato MN|Willmar MN|Wausau WI|Marshfield WI|Rhinelander WI|Marquette MI|Escanaba MI|Traverse City MI|Alpena MI|Mount Pleasant MI|Ottumwa IA|Mason City IA|Fort Dodge IA|Spencer IA|Quincy IL|Mattoon IL|Effingham IL|Carbondale IL|Vincennes IN|Marion IN|Columbus IN|Jasper IN|Chillicothe OH|Marietta OH|Zanesville OH|Findlay OH|Paducah KY|Hopkinsville KY|Somerset KY|Pikeville KY|Cookeville TN|Jackson TN|Tullahoma TN|Morristown TN|Tupelo MS|Hattiesburg MS|Meridian MS|Greenville MS|Dothan AL|Florence AL|Gadsden AL|Anniston AL|Valdosta GA|Albany GA|Dalton GA|Rome GA|Lake City FL|Palatka FL|Sebring FL|Marianna FL|Florence SC|Orangeburg SC|Sumter SC|Hickory NC|Rocky Mount NC|Goldsboro NC|Wilkesboro NC|Danville VA|Martinsville VA|Winchester VA|Beckley WV|Clarksburg WV|Parkersburg WV|Cumberland MD|Salisbury MD|Altoona PA|Williamsport PA|Johnstown PA|Oil City PA|Elmira NY|Olean NY|Watertown NY|Plattsburgh NY|Bangor ME|Presque Isle ME|Rutland VT|Keene NH|Torrington CT|Pittsfield MA|Texarkana TX|Lufkin TX|Nacogdoches TX|Victoria TX|Del Rio TX|Big Spring TX|Brownwood TX|Paris TX|Ardmore OK|Enid OK|Stillwater OK|Muskogee OK|Jonesboro AR|Hot Springs AR|Russellville AR|El Dorado AR|Monroe LA|Alexandria LA|Natchitoches LA|Houma LA|Joplin MO|Rolla MO|Sedalia MO|Cape Girardeau MO|Pocatello ID|Twin Falls ID|Lewiston ID|Coeur d'Alene ID|Helena MT|Bozeman MT|Great Falls MT|Kalispell MT|Klamath Falls OR|Roseburg OR|Pendleton OR|Wenatchee WA|Walla Walla WA|Port Angeles WA|Eureka CA|Yreka CA|El Centro CA|Barstow CA|Ketchikan AK|Fairbanks AK`).split("|");

// Franchises and chains (their sites are corporate; our pitch doesn't fit).
const CHAIN = /\b(midas|meineke|jiffy|firestone|goodyear|pep boys|valvoline|take 5|maaco|caliber|gerber|service king|roto-rooter|mr\.? rooter|benjamin franklin|one hour|aire serv|ars\b|rescue rooter|terminix|orkin|truly nolen|servpro|servicemaster|stanley steemer|chem-?dry|molly maid|merry maids|two men and a truck|great clips|supercuts|sport clips|fantastic sams|planet fitness|anytime fitness|snap fitness|crossfit|ups store|fedex|sherwin|home depot|lowe'?s|ace hardware|true value|mattress firm|petsmart|petco|subway|mcdonald|starbucks|dunkin|walmart|aamco|cottman|safelite|precision tune|christian brothers|batteries plus|mister sparky|mosquito joe|weed man|trugreen|lawn doctor|window world|bath fitter|re-?bath|paul davis|belfor|budget blinds|sears)\b/i;

// Builders whose sites already look modern, so our pitch won't land.
const MODERN = /wix\.com|wixstatic|squarespace|shopify|webflow|duda|godaddy\.com\/websites|img1\.wsimg|thryv|hibu|yext|scorpion|townsquare|weebly\.com\/uploads\/.*2[2-9]/i;
const OLD_GENERATOR = /<meta[^>]+generator[^>]+(frontpage|dreamweaver|coffeecup|iweb|homestead|web studio|sitebuilder|microsoft word|netobjects|adobe muse|freeservers|tripod|angelfire|intuit|website pro|yahoo! sitebuilder|imagestyler)/i;

const domainOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

async function get(url, ms = 12000) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(ms), headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", Accept: "text/html" } });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "html")) return null;
    return { url: res.url, html: (await res.text()).slice(0, 600000) };
  } catch {
    return null;
  }
}

// Scores how dated a homepage looks. 2+ counts as outdated (e.g. untouched since 2018).
function outdated(page, httpsWorks) {
  const h = page.html;
  const reasons = [];
  let score = 0;
  if (!/<meta[^>]+name=["']?viewport/i.test(h)) (score += 3), reasons.push("not built for phones (no viewport)");
  if (!httpsWorks) (score += 2), reasons.push("no https");
  const years = [...h.matchAll(/(?:©|&copy;|&#169;|copyright)[^<]{0,40}?((?:19|20)\d\d)(?:\s*[-–]\s*((?:19|20)\d\d))?/gi)].map((m) => Number(m[2] || m[1]));
  const year = years.length ? Math.max(...years) : null;
  if (year && year <= 2018) (score += 2), reasons.push(`copyright ${year}`);
  else if (year && year <= 2020) (score += 1), reasons.push(`copyright ${year}`);
  if ((h.match(/<table/gi) || []).length >= 5) (score += 1), reasons.push("table layout");
  if (/\.swf\b|shockwave-flash/i.test(h)) (score += 2), reasons.push("Flash");
  const gen = OLD_GENERATOR.exec(h);
  if (gen) (score += 2), reasons.push(`built with ${gen[1]}`);
  if (/<font[\s>]/i.test(h)) (score += 1), reasons.push("<font> tags");
  if (/jquery[-.]?1\.\d/i.test(h)) (score += 1), reasons.push("jQuery 1.x");
  if (year && year >= 2023 && score < 4) score = 0; // recently maintained
  return { score, reasons, year };
}

const BAD_EMAIL = /(example|sentry|wixpress|godaddy|domain\.com|yourdomain|email\.com|noreply|no-reply|donotreply|\.(png|jpe?g|gif|webp|svg)$|@2x|privacy|abuse)/i;
function emailsIn(html, domain) {
  const text = html.replace(/&#64;|\[at\]|\(at\)/gi, "@").replace(/&#46;/g, ".");
  const found = new Set([...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0].toLowerCase()));
  const list = [...found].filter((e) => !BAD_EMAIL.test(e) && e.length < 60);
  // Their own domain first, then free/ISP mail (common for old small-business sites).
  return list.sort((a, b) => (b.endsWith(`@${domain}`) ? 1 : 0) - (a.endsWith(`@${domain}`) ? 1 : 0));
}

async function checkSite(place) {
  const domain = domainOf(place.websiteUri);
  const httpsPage = await get(place.websiteUri.replace(/^http:/, "https:"));
  const page = httpsPage || (await get(place.websiteUri.replace(/^https:/, "http:")));
  if (!page) return { domain, skip: "site didn't load" };
  if (MODERN.test(page.html)) return { domain, skip: "modern site builder" };
  const o = outdated(page, Boolean(httpsPage));
  if (o.score < 2) return { domain, skip: `looks current (score ${o.score})` };
  let emails = emailsIn(page.html, domain);
  if (!emails.length) {
    // Contact/about pages linked from the homepage, or the usual names.
    const links = [...page.html.matchAll(/href=["']([^"'#]*(?:contact|about)[^"'#]*)["']/gi)].map((m) => m[1]).slice(0, 4);
    const tries = [...new Set([...links, "contact.html", "contact-us.html", "contact", "contact-us", "about.html"])].slice(0, 6);
    for (const t of tries) {
      let u;
      try {
        u = new URL(t, page.url).href;
      } catch {
        continue;
      }
      if (domainOf(u) !== domainOf(page.url)) continue;
      const sub = await get(u, 8000);
      if (sub) emails = emailsIn(sub.html, domain);
      if (emails.length) break;
    }
  }
  if (!emails.length) return { domain, skip: "no email printed on site" };
  return { domain, emails, ...o, finalUrl: page.url };
}

async function search(query) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "places.displayName,places.websiteUri,places.nationalPhoneNumber,places.formattedAddress,places.addressComponents,places.businessStatus",
    },
    body: JSON.stringify({ textQuery: query, pageSize: 20, regionCode: "US" }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Places search failed: ${out.error?.message || res.status}`);
  return out.places || [];
}

async function knownDomains() {
  const set = new Set(read(path.join(LEADS, "checked-domains.txt")).split(/\s+/).filter(Boolean).map((d) => d.replace(/^www\./, "").toLowerCase()));
  try {
    const res = await fetch(`${SITE}/api/admin/prospect-domains`, { headers: { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` } });
    if (res.ok) for (const d of (await res.json()).domains) set.add(d);
  } catch {}
  return set;
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

(async () => {
  if (!KEY) throw new Error("No Google Places key: save it in ~/.config/edz/google_places_key.");
  fs.mkdirSync(LEADS, { recursive: true });
  const searchedFile = path.join(LEADS, "searched.txt");
  const searched = new Set(read(searchedFile).split("\n").filter(Boolean));
  const known = await knownDomains();

  // Every trade × city pair in a fixed shuffled order (so runs spread across the country), minus ones already searched.
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const queries = TRADES.flatMap((t) => CITIES.map((c) => `${t} in ${c.replace(/ (\w\w)$/, ", $1")}`))
    .sort((a, b) => hash(a) - hash(b))
    .filter((q) => !searched.has(q))
    .slice(0, SEARCHES);

  const usageFile = path.join(LEADS, "places-usage.log");
  const month = new Date().toISOString().slice(0, 7);
  let usedThisMonth = read(usageFile).split("\n").filter((l) => l.startsWith(month)).length;
  console.log(`Google searches used this month: ${usedThisMonth} of ${MONTHLY_LIMIT}`);

  const candidates = [];
  const tally = {};
  const newDomains = [];
  for (const q of queries) {
    if (usedThisMonth >= MONTHLY_LIMIT) {
      console.log(`Stopped: reached ${MONTHLY_LIMIT} Google searches this month (PLACES_MONTHLY_LIMIT).`);
      break;
    }
    fs.appendFileSync(usageFile, `${new Date().toISOString()} ${q}\n`);
    usedThisMonth++;
    const places = await search(q);
    fs.appendFileSync(searchedFile, `${q}\n`);
    const fresh = [];
    for (const p of places) {
      const name = p.displayName?.text || "";
      const d = p.websiteUri && domainOf(p.websiteUri);
      const why = p.businessStatus && p.businessStatus !== "OPERATIONAL" ? "not operating" : !d ? "no website" : CHAIN.test(name) ? "chain" : known.has(d) ? "already checked" : /facebook|instagram|yelp|google|linktr|square\.site|business\.site/.test(d) ? "no real website" : null;
      if (why) {
        tally[why] = (tally[why] || 0) + 1;
        continue;
      }
      known.add(d);
      newDomains.push(d);
      fresh.push(p);
    }
    const checked = await pool(fresh, 8, async (p) => ({ p, r: await checkSite(p) }));
    for (const { p, r } of checked) {
      if (r.skip) {
        tally[r.skip.replace(/ \(score \d\)/, "")] = (tally[r.skip.replace(/ \(score \d\)/, "")] || 0) + 1;
        continue;
      }
      const comp = Object.fromEntries((p.addressComponents || []).flatMap((c) => c.types.map((t) => [t, c.shortText])));
      candidates.push({
        business: p.displayName.text,
        industry: q.split(" in ")[0].replace(/\b\w/g, (c) => c.toUpperCase()),
        city: comp.locality || comp.sublocality || "",
        state: comp.administrative_area_level_1 || "",
        phone: p.nationalPhoneNumber || "",
        email: r.emails[0],
        otherEmails: r.emails.slice(1, 4),
        address: p.formattedAddress?.replace(/, USA$/, "") || "",
        website: r.finalUrl,
        whyOutdated: r.reasons.join(", "),
        outdatedScore: r.score,
        source: `Google Places search: ${q}`,
      });
    }
    console.log(`${q}: ${places.length} results, ${fresh.length} new sites, ${candidates.length} candidates so far`);
  }

  if (newDomains.length) fs.appendFileSync(path.join(LEADS, "checked-domains.txt"), newDomains.join("\n") + "\n");
  candidates.sort((a, b) => b.outdatedScore - a.outdatedScore);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const file = path.join(LEADS, `candidates-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(candidates, null, 2));
  console.log(`\n${queries.length} searches, ${newDomains.length} new websites checked, ${candidates.length} candidates → ${path.relative(ROOT, file)}`);
  console.log(`skipped: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
})().catch((err) => {
  console.error(`find-leads failed: ${err.message}`);
  process.exit(1);
});
