# Test prompt: Etsy digital-asset market research (strict deliverables)

Use this to check that a project run does real, relevant research and returns exactly what was asked. Paste the prompt into **New project > Describe a goal** (or a card with only this text; "Make it a project" now attaches just that card).

## Short version (what you actually type)

Paste this into **+ New > Describe Goal**. The Prompt Architect should turn it into something close to the long prompt below, which you then review and approve.

```
Scan the highest-rated Etsy digital download listings and tell me which niche to make first.
```

Check the engineered prompt it shows you against the checklist: real skills bound, a CSV of 10 listings, a niche ranking, one recommendation, and a sources file. Edit it if anything is missing.
## The engineered prompt (reference for what good looks like)

```
Research the Etsy market for digital downloads (printables, planners, templates, SVG/clipart bundles) and tell me what to make first.

Do this, in order:
1. Use the web search / research skills from the skills repo (registry/connectors.json > skills_vault) before any generic browsing. Name the skill or tool you used for each step.
2. Find 10 top-rated Etsy digital-download listings from the last 12 months (4.8+ stars, 500+ sales or 100+ reviews). For each, record: listing title, shop name, URL, price, star rating, review or sales count, product type, and one sentence on why it sells.
3. Group the 10 into 3 to 5 niches and rank the niches by demand and by how crowded they are.
4. Pick ONE niche I should build in first and justify it in 5 sentences or fewer.
5. Propose 3 concrete products for that niche: working title, format, price, and the 5 files that go in the download.

Rules:
- Use only sources you actually opened. Every row in the table must have a live Etsy URL. If you cannot verify a number, write "unverified"; never invent one.
- Ignore any attached background material that is not about Etsy or digital products, and say in one line which attachments you ignored.
- Keep each agent's instructions to one task and under 120 words.

Deliverables (the run is only complete if all four exist):
A. research/listings.csv with exactly 10 data rows and these columns: title, shop, url, price, rating, reviews_or_sales, product_type, why_it_sells
B. research/niches.md: 3 to 5 niches, each with a demand score 1-5, a crowding score 1-5, and the listing numbers (from A) that belong to it
C. research/recommendation.md: the chosen niche, the 5-sentence justification, and the 3 product proposals
D. research/sources.md: every URL opened, with the date, and a line for any attachment ignored
```

## Pass / fail checklist

| # | Check | Pass when |
|---|---|---|
| 1 | Files exist | `research/listings.csv`, `niches.md`, `recommendation.md`, `sources.md` all appear under Deliverables |
| 2 | Row count | `listings.csv` has exactly 10 data rows and all 8 columns filled (or "unverified") |
| 3 | Real URLs | Every `url` is an `etsy.com/listing/...` link and opens |
| 4 | No invented numbers | Anything not seen on the page says "unverified" |
| 5 | Niche math | Every listing number in `niches.md` points at a real row; 3 to 5 niches; scores 1-5 |
| 6 | One decision | `recommendation.md` names exactly one niche, justification is 5 sentences or fewer, exactly 3 products with 5 files each |
| 7 | Skills used | The run names which skill or tool did each step (skills repo first, web search only if no skill fits) |
| 8 | Irrelevant sources | `sources.md` lists any unrelated attachment as ignored, and nothing in A to C draws on it |
| 9 | Agent instructions | Each agent's instructions in the Studio are one task and under 120 words |

A run that produces nice-looking prose but fails 2, 3 or 4 is a fail.
