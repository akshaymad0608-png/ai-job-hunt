/**
 * Job hunter — zero dependencies, Node 18+ (uses global fetch).
 *
 * Does what `JOB ENGINE · Auto Apply` does, minus the parts that need a
 * working n8n instance: fetch postings, score them against the résumé profile
 * in profile.json, drop everything already seen, and write a ranked shortlist.
 *
 * The reason it exists as a local script: the n8n cloud trial ended between
 * executions 503 and 507 on 2026-09-09, and every execution since fails in
 * ~40ms inside a pre-execute hook, account-wide. The workflow is still
 * published and still correct — it just cannot run. This runs.
 *
 * The reason it adds LinkedIn: measured on 2026-09-10, the five free job APIs
 * the workflow polls returned 1,768 postings, 473 unique, of which THREE were
 * India-eligible AI roles. LinkedIn's public job-search endpoint returned 41
 * in the same run. For a candidate based in India the free feeds are close to
 * empty, and no amount of scoring fixes an empty input.
 *
 * Usage:
 *   node hunt.mjs                  # fetch, score, write reports/
 *   node hunt.mjs --briefs         # also write a pitch brief per shortlisted role
 *   node hunt.mjs --all            # ignore seen.json, re-score everything
 *   node hunt.mjs --min 50         # override the profile's minScore
 *   node hunt.mjs --linkedin-only  # skip the remote feeds
 *
 * Nothing here sends an email, logs into LinkedIn, or clicks Apply. It reads
 * public endpoints and writes files. Applying stays a human action.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30000;
const PROFILE = JSON.parse(readFileSync(join(HERE, 'profile.json'), 'utf8'));
const SEEN_PATH = join(HERE, 'seen.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1];
};

const MIN_SCORE = Number(opt('min') ?? PROFILE.scoring.minScore);
const WANT_BRIEFS = flag('briefs');
const IGNORE_SEEN = flag('all');
const LINKEDIN_ONLY = flag('linkedin-only');

/* ----------------------------------------------------------------- fetch -- */

async function grab(url, accept = 'text/html,*/*') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.text() };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(t);
  }
}

async function grabJson(url) {
  const r = await grab(url, 'application/json,*/*');
  if (!r.ok) return r;
  try {
    return { ok: true, data: JSON.parse(r.body) };
  } catch {
    return { ok: false, error: 'bad JSON' };
  }
}

/* --------------------------------------------------------------- parsing -- */

const decode = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');

const strip = (s) => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Each guest-search card is one <div class="base-card" data-entity-urn=...>.
// Splitting on that attribute is stabler than trying to balance <li> tags —
// LinkedIn's fragment leaves several of them unclosed.
function parseLinkedIn(html) {
  const out = [];
  const cards = html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1);
  for (const card of cards) {
    const id = card.slice(0, card.indexOf('"'));
    if (!/^\d+$/.test(id)) continue;
    const pick = (cls) => {
      const m = card.match(new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/`, 'i'));
      return m ? strip(m[1]) : '';
    };
    const date = (card.match(/<time[^>]*datetime="([\d-]+)"/i) || [])[1] || '';
    out.push({
      src: 'LinkedIn',
      id,
      title: pick('base-search-card__title'),
      company: pick('base-search-card__subtitle'),
      loc: pick('job-search-card__location'),
      salary: pick('job-search-card__salary-info'),
      // The href carries tracking params that change every request, which would
      // defeat dedupe. The canonical /jobs/view/<id>/ form is stable.
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      desc: '',
      date,
    });
  }
  return out;
}

/* --------------------------------------------------------------- sources -- */

const jobs = [];
const notes = [];

function record(name, n, err) {
  notes.push({ source: name, count: n, error: err || null });
  const tail = err ? `FAILED — ${err}` : `${n}`;
  console.log(`  ${name.padEnd(34)} ${tail}`);
}

async function fromLinkedIn() {
  for (const s of PROFILE.searches) {
    const label = `LinkedIn · ${s.keywords} · ${s.location}`;
    let got = 0;
    let lastErr = null;
    // Guest search pages in tens. Two pages is where new-posting density drops
    // off; going deeper mostly re-surfaces the same reposts.
    for (const start of [0, 10]) {
      const url =
        'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search' +
        `?keywords=${encodeURIComponent(s.keywords)}` +
        `&location=${encodeURIComponent(s.location)}` +
        '&f_TPR=r604800' +
        (s.remoteOnly ? '&f_WT=2' : '') +
        `&start=${start}`;
      const r = await grab(url);
      if (!r.ok) {
        lastErr = r.error;
        break;
      }
      const parsed = parseLinkedIn(r.body);
      if (!parsed.length) break;
      for (const j of parsed) {
        j.query = s.keywords;
        jobs.push(j);
      }
      got += parsed.length;
      await new Promise((r) => setTimeout(r, 700)); // be a polite client
    }
    record(label, got, lastErr);
  }
}

async function fromRemotive() {
  let n = 0;
  let err = null;
  for (const q of ['ai automation', 'prompt engineer', 'ai engineer', 'react', 'n8n']) {
    const r = await grabJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`);
    if (!r.ok) { err = r.error; continue; }
    for (const j of r.data.jobs || []) {
      jobs.push({
        src: 'Remotive', id: String(j.id), title: j.title, company: j.company_name,
        loc: j.candidate_required_location, url: j.url, salary: j.salary || '',
        desc: strip(j.description).slice(0, 1200), date: (j.publication_date || '').slice(0, 10),
        query: q,
      });
      n++;
    }
  }
  record('Remotive', n, err);
}

async function fromRemoteOK() {
  const r = await grabJson('https://remoteok.com/api');
  if (!r.ok) return record('RemoteOK', 0, r.error);
  let n = 0;
  for (const j of r.data.slice(1)) {
    jobs.push({
      src: 'RemoteOK', id: String(j.id), title: j.position, company: j.company,
      loc: j.location || 'Remote', url: j.url, desc: strip(j.description).slice(0, 1200),
      date: (j.date || '').slice(0, 10),
      salary: j.salary_min ? `$${j.salary_min}–$${j.salary_max}` : '',
      query: 'feed',
    });
    n++;
  }
  record('RemoteOK', n);
}

async function fromHimalayas() {
  let n = 0;
  let err = null;
  for (const offset of [0, 100]) {
    const r = await grabJson(`https://himalayas.app/jobs/api?limit=100&offset=${offset}`);
    if (!r.ok) { err = r.error; break; }
    const list = r.data.jobs || [];
    if (!list.length) break;
    for (const j of list) {
      const locs = j.locationRestrictions || [];
      jobs.push({
        src: 'Himalayas', id: String(j.guid || j.title), title: j.title, company: j.companyName,
        loc: locs.length ? locs.join(', ') : 'Worldwide',
        url: j.applicationLink || j.guid, salary: j.salary || '',
        desc: strip(j.excerpt || j.description).slice(0, 1200),
        date: typeof j.pubDate === 'number'
          ? new Date(j.pubDate * 1000).toISOString().slice(0, 10) : '',
        query: 'feed',
      });
      n++;
    }
  }
  record('Himalayas', n, err);
}

async function fromJobicy() {
  let n = 0;
  let err = null;
  // No `geo` filter: Jobicy now 400s on geo=india and geo=asia, and `tag=ai`
  // is rejected for being under three characters. An earlier version swallowed
  // both failures in a try/catch and reported a healthy count from the one
  // call that happened to have no filter at all — the whole geo filter had
  // never worked. Filter by industry instead and let the scorer handle geo.
  for (const q of ['', '&tag=automation', '&industry=engineering']) {
    const r = await grabJson(`https://jobicy.com/api/v2/remote-jobs?count=50${q}`);
    if (!r.ok) { err = r.error; continue; }
    for (const j of r.data.jobs || []) {
      jobs.push({
        src: 'Jobicy', id: String(j.id), title: j.jobTitle, company: j.companyName,
        loc: j.jobGeo || 'Anywhere', url: j.url,
        desc: strip(j.jobExcerpt).slice(0, 1200), date: String(j.pubDate || '').slice(0, 10),
        salary: j.annualSalaryMin
          ? `${j.annualSalaryMin}–${j.annualSalaryMax} ${j.salaryCurrency || ''}`.trim() : '',
        query: q || 'feed',
      });
      n++;
    }
  }
  record('Jobicy', n, err);
}

async function fromWorkingNomads() {
  const r = await grabJson('https://www.workingnomads.com/api/exposed_jobs/');
  if (!r.ok) return record('Working Nomads', 0, r.error);
  let n = 0;
  for (const j of r.data) {
    jobs.push({
      src: 'WorkingNomads', id: String(j.id || j.url), title: j.title, company: j.company_name,
      loc: j.location || 'Remote', url: j.url, salary: '',
      desc: strip(j.description).slice(0, 1200), date: (j.pub_date || '').slice(0, 10),
      query: 'feed',
    });
    n++;
  }
  record('Working Nomads', n);
}

/* --------------------------------------------------------------- scoring -- */

const S = PROFILE.scoring;
const hits = (hay, terms) => terms.filter((t) => hay.includes(t));

function score(job) {
  const title = (job.title || '').toLowerCase();
  const desc = (job.desc || '').toLowerCase();
  const loc = (job.loc || '').toLowerCase();
  const blob = `${title} ${desc}`;

  let total = 0;
  const why = [];
  const add = (pts, label) => { total += pts; if (label) why.push(label); };

  if (hits(title, S.hotTitle.terms).length) add(S.hotTitle.points, 'AI/automation title');
  else if (hits(title, S.adjacentTitle.terms).length) add(S.adjacentTitle.points, 'adjacent dev title');
  else add(-10);

  if (desc && hits(desc, S.hotTitle.terms).length) add(S.hotInDescription.points, 'AI/automation named in JD');

  const stack = [...new Set(hits(blob, S.stack.terms))];
  if (stack.length) add(Math.min(stack.length * S.stack.pointsEach, S.stack.max), `stack: ${stack.slice(0, 6).join(', ')}`);

  // Geo is read from the location field ONLY. Judging it from the description
  // let location-locked roles through — an early run surfaced eight jobs in
  // Brazil, Mexico and Berlin whose descriptions merely said "remote".
  const g = S.geo;
  if (hits(loc, g.home.terms).length) add(g.home.points, 'Gujarat — commutable');
  else if (hits(loc, g.country.terms).length) add(g.country.points, 'India-eligible');
  else if (hits(loc, g.worldwide.terms).length) add(g.worldwide.points, 'worldwide remote');
  else if (hits(loc, g.region.terms).length) add(g.region.points, 'APAC');
  else if (hits(loc, g.lockedAbroad.terms).length) add(g.lockedAbroad.points, 'geo-locked abroad');
  else if (loc.includes('remote')) add(g.vagueRemote.points, 'remote, geo unstated');

  if (hits(title, S.seniority.terms).length) add(S.seniority.points, 'seniority above band');
  const off = hits(title, S.offStack.terms);
  if (off.length) add(S.offStack.points, `off-stack: ${off[0].trim()}`);

  job.score = total;
  job.why = why.join('; ');
  job.stackHits = stack;
  return total;
}

/* -------------------------------------------------------------- enriching -- */

// A LinkedIn search card carries no description at all. That is fine for
// scoring — title and location do that work — but it wrecks the briefs: with
// an empty desc every posting matched only the word "automation" in its own
// title, so thirteen of fifteen briefs came back recommending the same two
// projects and flagged no gaps. The per-posting guest endpoint returns the
// real JD, so briefs fetch it for the shortlist only.
async function fetchJd(id) {
  const r = await grab(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
  if (!r.ok) return null;
  const m = r.body.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  return m ? strip(m[1]) : null;
}

async function enrich(list) {
  let filled = 0;
  for (const j of list) {
    if (j.src !== 'LinkedIn' || j.desc) continue;
    const jd = await fetchJd(j.id);
    if (jd) { j.desc = jd.slice(0, 4000); j.enriched = true; filled++; score(j); }
    await new Promise((r) => setTimeout(r, 700));
  }
  return filled;
}

/* ---------------------------------------------------------------- briefs -- */

// Picks which of the résumé's projects to lead with for a given posting, and
// names the gap it will be judged against. Deliberately template-free prose is
// NOT generated here — a mechanically written cover letter reads like one.
function brief(job) {
  const blob = `${job.title} ${job.desc} ${job.query}`.toLowerCase();
  const ranked = PROFILE.evidence
    .map((e) => ({ ...e, n: e.triggers.filter((t) => blob.includes(t)).length }))
    .sort((a, b) => b.n - a.n);
  const lead = ranked.filter((e) => e.n > 0).slice(0, 3);
  const picked = lead.length ? lead : ranked.slice(0, 2);

  const gaps = [];
  if (/python|django|flask|fastapi/.test(blob)) gaps.push(PROFILE.gaps.python);
  if (/aws|gcp|azure|kubernetes|terraform/.test(blob)) gaps.push(PROFILE.gaps.cloud);
  if (/\b([5-9]|1\d)\+? ?(years|yrs)\b/.test(blob)) gaps.push(PROFILE.gaps.years);
  if (/lead|mentor|manage|team of/.test(blob)) gaps.push(PROFILE.gaps.team);

  return {
    role: `${job.title} — ${job.company}`,
    url: job.url,
    score: job.score,
    leadWith: picked.map((e) => ({ project: e.name, line: e.line })),
    matchedStack: job.stackHits,
    addressHeadOn: gaps,
  };
}

/* ---------------------------------------------------------------- output -- */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function writeHtml(list, stamp, path) {
  const rows = list.map((j) => `
    <tr>
      <td class="s">${j.score}${j.enriched ? '<span class="e" title="scored on the full job description">*</span>' : ''}</td>
      <td><a href="${esc(j.url)}">${esc(j.title)}</a><br><span class="c">${esc(j.company)}</span></td>
      <td>${esc(j.loc)}</td>
      <td class="d">${esc(j.date)}</td>
      <td class="w">${esc(j.why)}</td>
      <td class="d">${esc(j.src)}</td>
    </tr>`).join('');

  writeFileSync(path, `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job shortlist — ${stamp}</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1rem;max-width:70rem;margin-inline:auto}
 h1{font-size:1.5rem;margin:0 0 .25rem}
 p.sub{color:#6b7280;margin:0 0 1.5rem}
 table{width:100%;border-collapse:collapse}
 th{text-align:left;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;
    border-bottom:2px solid currentColor;padding:.4rem .5rem}
 td{padding:.6rem .5rem;border-bottom:1px solid rgba(128,128,128,.25);vertical-align:top}
 td.s{font-variant-numeric:tabular-nums;font-weight:700;width:3rem}
 td.d{font-size:.8rem;color:#6b7280;white-space:nowrap}
 td.w{font-size:.82rem;color:#6b7280;max-width:22rem}
 span.c{color:#6b7280;font-size:.85rem}
 span.e{color:#b45309}
 a{color:inherit}
 p.note{color:#6b7280;font-size:.82rem;margin:0 0 1.5rem;max-width:60rem}
</style>
<h1>Job shortlist</h1>
<p class="sub">${list.length} roles scoring ${MIN_SCORE}+ · generated ${stamp}</p>
${list.some((j) => j.enriched) ? `<p class="note">A <span class="e">*</span> means the score was recomputed against the full
job description rather than the search card alone. Only the roles that got a pitch brief were
fetched that way, so a starred score is worth more points than an unstarred one for the same
role — compare starred with starred.</p>` : ''}
<table>
 <thead><tr><th>Fit</th><th>Role</th><th>Location</th><th>Posted</th><th>Why</th><th>Source</th></tr></thead>
 <tbody>${rows}</tbody>
</table>`);
}

/* ------------------------------------------------------------------ main -- */

console.log('\nFetching…');
await fromLinkedIn();
if (!LINKEDIN_ONLY) {
  await fromRemotive();
  await fromRemoteOK();
  await fromHimalayas();
  await fromJobicy();
  await fromWorkingNomads();
}

const seen = !IGNORE_SEEN && existsSync(SEEN_PATH)
  ? new Set(JSON.parse(readFileSync(SEEN_PATH, 'utf8')).keys || [])
  : new Set();

const keyOf = (j) => `${j.src}:${j.id}`.toLowerCase();
const dupe = new Set();
const fresh = [];
let skippedSeen = 0;

for (const j of jobs) {
  if (!j.title || !j.url) continue;
  // Two keys: the source id catches the same posting across runs, the
  // title+company pair catches the same role listed under several queries.
  const k = keyOf(j);
  const pair = `${j.title}|${j.company}`.toLowerCase().replace(/\s+/g, ' ').trim();
  if (dupe.has(k) || dupe.has(pair)) continue;
  dupe.add(k); dupe.add(pair);
  if (seen.has(k)) { skippedSeen++; continue; }
  score(j);
  fresh.push(j);
}

let shortlist = fresh.filter((j) => j.score >= MIN_SCORE).sort((a, b) => b.score - a.score);

if (WANT_BRIEFS) {
  // Enrich a little deeper than the brief count, because a real JD re-scores
  // the role and can reorder the top of the list.
  const pool = shortlist.slice(0, 22);
  console.log(`\nFetching job descriptions for the top ${pool.length}…`);
  const filled = await enrich(pool);
  console.log(`  ${filled} descriptions retrieved`);
  shortlist = shortlist.sort((a, b) => b.score - a.score);
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const slug = new Date().toISOString().slice(0, 10);
const outDir = join(HERE, 'reports');
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, `shortlist-${slug}.json`), JSON.stringify({
  generated: new Date().toISOString(),
  minScore: MIN_SCORE,
  sources: notes,
  fetched: jobs.length,
  unique: fresh.length + skippedSeen,
  skippedAlreadySeen: skippedSeen,
  shortlisted: shortlist.length,
  jobs: shortlist,
}, null, 1));

writeHtml(shortlist, stamp, join(outDir, `shortlist-${slug}.html`));

if (WANT_BRIEFS) {
  writeFileSync(join(outDir, `briefs-${slug}.json`),
    JSON.stringify(shortlist.slice(0, 15).map(brief), null, 1));
}

// Only mark things seen once they have actually been reported, so a crash
// mid-run never silently swallows a posting you were never shown.
writeFileSync(SEEN_PATH, JSON.stringify({
  updated: new Date().toISOString(),
  keys: [...new Set([...seen, ...fresh.map(keyOf)])],
}, null, 1));

console.log(`\n${jobs.length} fetched · ${fresh.length} new after dedupe · ` +
  `${skippedSeen} already seen · ${shortlist.length} scoring ${MIN_SCORE}+\n`);

for (const j of shortlist.slice(0, 30)) {
  const loc = (j.loc || '').slice(0, 26);
  console.log(
    `${String(j.score).padStart(4)}  ${(j.title || '').slice(0, 46).padEnd(46)}` +
    `  ${(j.company || '').slice(0, 22).padEnd(22)}  ${loc.padEnd(26)}  ${j.date}`);
}

console.log(`\nreports/shortlist-${slug}.html`);
if (WANT_BRIEFS) console.log(`reports/briefs-${slug}.json`);
console.log('Nothing was sent. Apply from the links yourself.\n');
