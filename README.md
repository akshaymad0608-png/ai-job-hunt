# Job Hunt

Scores live job postings against a résumé profile and writes a ranked
shortlist. Six sources — LinkedIn's public job search plus five open remote-job
APIs — deduped across runs, with an optional pitch brief per role saying which
of your projects to lead with and which gap the posting will judge you on.

Node 18+. Zero dependencies, no install, no API key, no credentials, no login.

It started as a local replacement for an n8n workflow (`JOB ENGINE · Auto
Apply`) whose hosted instance stopped running, and the port is where the
interesting part came from: measuring the sources properly showed the workflow's
scoring had never been the problem — its input was.

```bash
node hunt.mjs                  # fetch, score, write reports/
node hunt.mjs --briefs         # also write a pitch brief per shortlisted role
node hunt.mjs --all            # ignore seen.json, re-score everything
node hunt.mjs --min 50         # override profile.json's minScore
node hunt.mjs --linkedin-only  # skip the five remote feeds
```

## Why it exists

Two measured reasons, not preferences.

**The n8n workflow cannot run.** The cloud trial ended between executions 503
and 507 on 2026-09-09. Every execution since fails in ~40ms inside a
pre-execute hook, account-wide — including schedule-triggered workflows with no
webhook. `JOB ENGINE · Auto Apply` is still published and still active; it just
never gets past the hook. Verified again on 2026-09-10: executions 643–650, all
`error`, all under 150ms.

**The five free feeds are close to empty for India.** Measured 2026-09-10:

| | Postings | Unique | India-eligible AI roles |
|---|---|---|---|
| Remotive + RemoteOK + Himalayas + Jobicy + Working Nomads | 1,768 | 473 | **3** |
| LinkedIn public job search | 240 | ~150 | **41** |

That is the whole finding. The workflow's scoring was never the problem — the
input was. For a candidate based in Surat, LinkedIn is the only one of the six
sources that returns the roles the résumé actually matches.

## How it works

1. **Fetch.** LinkedIn's public `jobs-guest` search endpoint across the twelve
   keyword/location pairs in `profile.json`, two pages each, restricted to the
   last seven days — plus the five JSON feeds the n8n workflow already polls.
   No login. Requests are spaced 700ms apart.
2. **Score.** Deterministic keyword scoring against `profile.json`: title match,
   stack overlap, geography, seniority band, off-stack penalties. Same weights
   as the workflow's `Normalize And Score Jobs` node.
3. **Dedupe.** Against `seen.json`, on two keys — source id (same posting across
   runs) and title+company (same role surfaced by several queries).
4. **Enrich (`--briefs` only).** A LinkedIn search card carries no description,
   so the top 22 get their real JD pulled from the per-posting guest endpoint
   and are re-scored against it. Those rows are marked `*` in the HTML: a
   starred score saw the full JD and an unstarred one saw only the card, so the
   two are not comparable — compare starred with starred.
5. **Gate on eligibility (`--briefs` only).** Fit and eligibility are different
   questions and the scorer only answered the first: a role demanding 7–11
   years scored 105 and led the list, and so did one whose shift is 5pm–3am.
   Neither fact is on the search card. Enriched rows are now penalised for
   years beyond reach, a night shift, and onsite-only outside Gujarat — as
   penalties, not filters, because a bar missed by a year is still worth
   seeing. Weights live under `scoring.eligibility` in `profile.json`.
6. **Report.** `reports/shortlist-<date>.{json,html}`, ranked. With `--briefs`,
   also `reports/briefs-<date>.json`: for each of the top 15, which of the
   résumé's projects to lead with and which gap the posting will judge you on.

The enrichment step is what makes briefs worth reading. Without a JD the brief
matcher only ever saw the job title, so it matched on the word "automation"
that every shortlisted role already has: thirteen of fifteen briefs recommended
the identical two projects and twelve flagged no gaps at all. With the JD
fetched it is fourteen distinct recommendations out of fifteen, fourteen with
gaps named, and 6.6 matched stack terms per role instead of one.

`seen.json` is only written after the report is, so a crash mid-run never
swallows a posting you were never shown.

## What it does not do

It does not send email, log into LinkedIn, or click Apply. LinkedIn Easy Apply
needs an authenticated browser session and automating it breaks their terms —
the same conclusion the n8n Job Engine reached and documented. Apify would not
change that: `docker-compose.yml` expects `APIFY_TOKEN`,
`APIFY_LINKEDIN_ACTOR` and `APIFY_POST_ACTOR`, but the repo ships only
`.env.example`, and an Apify actor scraping logged-in LinkedIn has the same
terms problem.

Applying stays a human action. This tool's job is to make sure the right
twenty links are in front of you the morning they are posted.

## Tuning

Everything tunable is in `profile.json` — `hunt.mjs` reads it and holds no
keyword lists of its own.

| Knob | Where | Default |
|---|---|---|
| Which searches run | `searches[]` | 12 keyword/location pairs |
| Shortlist cutoff | `scoring.minScore` | 35 |
| Title / stack / geo weights | `scoring.*.points` | see file |
| Projects a brief can lead with | `evidence[]` | 7 |
| Gaps a brief names honestly | `gaps` | 4 |

Geography is scored from the **location field only**, never the description.
Reading it from the description let location-locked roles through — an early
run surfaced eight jobs in Brazil, Mexico and Berlin whose descriptions merely
said "remote".

## Two traps already hit

**Jobicy's `geo` filter silently did nothing.** `geo=india` and `geo=asia` both
return HTTP 400, and `tag=ai` is rejected for being under three characters. An
earlier version caught those in a try/catch and moved on, so the run reported a
healthy Jobicy count — supplied entirely by the one call that happened to carry
no filter. The geo filter had never worked. It now filters by industry and lets
the scorer handle geography, and a failing source prints `FAILED` in the run
log instead of being absorbed.

**A years figure is read at its lowest, and the spread is reported.** Postings
restate their bar loosely further down, so penalising on the highest figure
would hide roles that are actually open. EXL's JD carries both "1–3+ years" and
"5 to 12 years"; it scores at 1 deliberately. But printing `asks 1y` beside it
and saying nothing else would be a lie of omission, so when the low and high
differ by more than a year the note says `JD also says 12y` and the range is
itself the warning. That note carries no penalty.

**LinkedIn's card hrefs are not stable.** Every response carries fresh
`refId` and `trackingId` params, so keying dedupe on the href would treat the
same posting as new on every run. The canonical `/jobs/view/<id>/` form is
built from `data-entity-urn` instead.

## When n8n comes back

Port `fromLinkedIn()` and `parseLinkedIn()` into the workflow as a sixth HTTP
source feeding the same merge node. The scoring in `hunt.mjs` is deliberately a
straight port of `Normalize And Score Jobs`, so only the fetch half is new
work. Nothing else in the workflow needs to change.
