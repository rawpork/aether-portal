// Roadmap templates: ready-made project plans, phase by phase, that the New project dialog launches in one step. Each is turned into
// a blueprint spec whose one source is the roadmap written out (templates.js does the same for its brief), so Elarion plans the
// work from the phases and goals below. Launched ones are indexed with the tags template, ingest and roadmap.
import { BRIEF_SOURCE_URL } from './templates.js';

// The filter tabs in the wizard. A template lists the categories it belongs to; "all" shows every one.
export const ROADMAP_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'rapid', label: 'Rapid (1-Day)' },
  { id: 'affiliate', label: 'Affiliate & Offer Campaigns' },
  { id: 'marketing', label: 'Marketing & Funnels' },
  { id: 'seo', label: 'SEO & Web Development' },
  { id: 'app', label: 'App & SaaS Creation' },
];

export const ROADMAP_TEMPLATES = [
  {
    id: 'launch-30',
    categories: ['marketing'],
    name: '30-day product launch',
    horizon: '4 weeks',
    summary: 'From a validated idea to a live page, a first audience and a first sale.',
    phases: [
      { title: 'Week 1: Position', goals: ['Define who it is for and the one problem it solves', 'Write the offer and a price', 'Pick three competitors and note how this differs'] },
      { title: 'Week 2: Build', goals: ['Ship a landing page with a clear call to action', 'Set up sign-up capture and analytics', 'Draft the launch email and three posts'] },
      { title: 'Week 3: Reach', goals: ['Publish the posts and send the email', 'Reach out to 20 people who fit the audience', 'Collect every reply and objection'] },
      { title: 'Week 4: Learn', goals: ['Count sign-ups, replies and sales', 'Fix the biggest objection on the page', 'Decide: double down, change course or stop'] },
    ],
  },
  {
    id: 'mvp-8w',
    categories: ['app'],
    name: '8-week MVP build',
    horizon: '8 weeks',
    summary: 'Scope, build and test the smallest version of a product people can use.',
    phases: [
      { title: 'Weeks 1-2: Scope', goals: ['List the one job the product must do', 'Cut every feature that is not that job', 'Sketch the screens and the data it keeps'] },
      { title: 'Weeks 3-5: Build', goals: ['Build the core flow end to end', 'Add sign-in and saving', 'Write tests for the paths people will use most'] },
      { title: 'Weeks 6-7: Test', goals: ['Put it in front of five real users', 'Record where they get stuck', 'Fix the top three problems'] },
      { title: 'Week 8: Release', goals: ['Deploy it', 'Write the help page and the changelog', 'Plan the next two weeks from what users asked for'] },
    ],
  },
  {
    id: 'content-90',
    categories: ['marketing', 'seo'],
    name: '90-day content and audience plan',
    horizon: '12 weeks',
    summary: 'A steady publishing rhythm that grows an audience and feeds the product.',
    phases: [
      { title: 'Month 1: Foundations', goals: ['Choose the three topics you will be known for', 'Set the publishing rhythm and the channels', 'Write the first eight pieces'] },
      { title: 'Month 2: Rhythm', goals: ['Publish on schedule and reuse each piece in two formats', 'Start an email list with a clear reason to join', 'Review which pieces got attention'] },
      { title: 'Month 3: Growth', goals: ['Double down on the two best-performing topics', 'Invite three collaborators or guest posts', 'Turn the best pieces into a guide or product'] },
    ],
  },
  {
    id: 'discovery-2w',
    categories: ['app', 'marketing'],
    name: 'Customer discovery sprint',
    horizon: '2 weeks',
    summary: 'Find out whether a problem is real, and who will pay to solve it, before building.',
    phases: [
      { title: 'Days 1-3: Prepare', goals: ['Write the problem as a testable claim', 'List 30 people who might have it', 'Prepare five interview questions that are not leading'] },
      { title: 'Days 4-10: Interview', goals: ['Talk to at least 10 of them', 'Write down their own words for the problem', 'Note what they do today and what it costs them'] },
      { title: 'Days 11-14: Decide', goals: ['Group the answers and count the patterns', 'Score the problem on pain, frequency and willingness to pay', 'Write a go, change or stop recommendation'] },
    ],
  },
  {
    id: 'site-revamp',
    categories: ['seo'],
    name: 'Website revamp',
    horizon: '3 weeks',
    summary: 'Audit what is there, rewrite what matters, and relaunch with measurable goals.',
    phases: [
      { title: 'Week 1: Audit', goals: ['Run an SEO and speed audit of the current site', 'List the pages that bring traffic and the pages that convert', 'Set a goal for sign-ups or sales'] },
      { title: 'Week 2: Rewrite', goals: ['Rewrite the home page and the top three pages', 'Fix titles, descriptions and headings', 'Add proof: reviews, numbers, logos'] },
      { title: 'Week 3: Relaunch', goals: ['Publish and redirect old addresses', 'Submit the sitemap', 'Check the numbers after a week and list the next fixes'] },
    ],
  },
  {
    id: 'sidehustle-14',
    categories: ['affiliate', 'marketing'],
    name: 'Side-hustle validation',
    horizon: '2 weeks',
    summary: 'Test a small business idea cheaply: a page, an offer and a handful of real conversations.',
    phases: [
      { title: 'Days 1-4: Offer', goals: ['Write the offer in one sentence with a price', 'Make a one-page site that explains it', 'Set a pass mark, for example 10 sign-ups'] },
      { title: 'Days 5-12: Test', goals: ['Share it in three places where the audience already is', 'Message 25 people directly', 'Log every reply'] },
      { title: 'Days 13-14: Verdict', goals: ['Compare the results to the pass mark', 'Write what you learned', 'Choose: continue, pivot or stop'] },
    ],
  },
  {
    id: 'local-audit-1d',
    categories: ['rapid', 'seo', 'marketing'],
    name: 'Local AI Business Audit & Sales Engine',
    horizon: '1 day',
    summary: 'Scan a local business site, score how ready it is for search and AI, write the audit and build a demo of the better site.',
    phases: [
      { title: 'Morning: Scan', goals: ['Take the business address or the niche and city, and find the site', 'Read the home page and two inner pages: titles, headings, structured data, speed, mobile', 'Check how the business shows up for an AI assistant: clear name, services, location, hours, reviews'] },
      { title: 'Midday: Score and report', goals: ['Score the site out of 100 on search, AI readiness, speed and trust, with the reason for each score', 'Write the audit report as a deliverable: the top five fixes in plain words, each with the effect it should have', 'Draft the one-page summary the owner will read first'] },
      { title: 'Afternoon: Demo and pitch', goals: ['Build a demo of the improved home page for this business', 'Write the short outreach message and the offer with a price, for your approval', 'Hand over the report, the demo preview and the message; nothing is sent until you approve'] },
    ],
  },
  {
    id: 'affiliate-brainiac-1d',
    categories: ['rapid', 'affiliate', 'marketing'],
    name: 'Affiliate Brainiac Campaign',
    horizon: '1 day to launch',
    summary: 'Take an affiliate offer, find the audience angles that fit, write the landing page and compile a launch plan you can run.',
    phases: [
      { title: 'Morning: Understand the offer', goals: ['Read the offer link or product spec: what it is, the price, the commission, the rules on how it may be promoted', 'Name the audience it fits and the problem it solves for them', 'Find three angles and pick the strongest, with the reason'] },
      { title: 'Midday: Build the page', goals: ['Write the landing page copy: headline, benefits, proof, answers to objections and one clear call to action', 'Lay out the page sections and the disclosure that this is an affiliate link', 'Draft the follow-up email and three posts'] },
      { title: 'Afternoon: Launch blueprint', goals: ['Compile the launch checklist as a runnable blueprint with an approval before anything is published or sent', 'Set the tracking: link, clicks and a pass mark for the first week', 'Hand over the page, the posts and the plan for your approval'] },
    ],
  },
];

export const ROADMAP_TAGS = ['template', 'ingest', 'roadmap'];
const SNIPPET_MAX = 1200;

// The templates in a category ("all" or an unknown id gives every one).
export const roadmapsIn = (category) => (category && category !== 'all' ? ROADMAP_TEMPLATES.filter((t) => (t.categories || []).includes(category)) : ROADMAP_TEMPLATES);

export const roadmapById = (id) => ROADMAP_TEMPLATES.find((t) => t.id === id) || ROADMAP_TEMPLATES[0];

// The roadmap written out as text: what Elarion reads.
export function roadmapText(template, notes = '') {
  const phases = template.phases.map((p) => p.title + ': ' + p.goals.join('; ') + '.').join(' ');
  const extra = String(notes || '').replace(/\s+/g, ' ').trim();
  return 'Roadmap template "' + template.name + '" (' + template.horizon + '). ' + template.summary + ' ' + phases + (extra ? ' Notes from the operator: ' + extra : '');
}

export function roadmapToSpec(template, { name = '', notes = '' } = {}) {
  return {
    projectName: String(name || '').trim().slice(0, 120) || template.name,
    lodLevel: 2,
    useMiserlyProxy: false,
    links: [{ url: BRIEF_SOURCE_URL, title: 'Roadmap: ' + template.name, rawSnippet: roadmapText(template, notes).slice(0, SNIPPET_MAX) }],
    interviewResponses: { database: 'cloudflare_d1', hosting: 'cloudflare_workers', unresolvedConnectors: [] },
  };
}
