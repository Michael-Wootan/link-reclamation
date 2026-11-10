#!/usr/bin/env node
/**
 * link-reclamation.js: broken backlink recovery + unlinked mention outreach
 *
 * Two strategies:
 *   1. BROKEN BACKLINKS: pulled from the Ahrefs API. Finds sites that link to
 *      us where the linking page now returns 404/410/etc. Draft an email
 *      asking the webmaster to fix or update the link.
 *   2. UNLINKED MENTIONS: parsed from Google Alert emails over IMAP. Finds
 *      pages that mention a brand term but do not link to us. Draft an email
 *      asking the site owner to add a link.
 *
 * Prerequisite for unlinked mentions:
 *   Google Alerts (google.com/alerts) for each brand term in config/brand.json,
 *   delivered to the mailbox in GMAIL_USER at "as-it-happens" frequency.
 *
 * Usage:
 *   node src/link-reclamation.js                    # full run + email report
 *   node src/link-reclamation.js --dry-run          # print report, no email
 *   node src/link-reclamation.js --broken-only      # only check broken backlinks
 *   node src/link-reclamation.js --mentions-only    # only check unlinked mentions
 */

const fs         = require('fs');
const { STATE_DIR, brand } = require('./config');

const path       = require('path');
const nodemailer = require('nodemailer');
const Anthropic  = require('@anthropic-ai/sdk');

// ── CLI flags ────────────────────────────────────────────────────────────────
const DRY_RUN       = process.argv.includes('--dry-run');
const BROKEN_ONLY   = process.argv.includes('--broken-only');
const MENTIONS_ONLY = process.argv.includes('--mentions-only');

// ── Files ───────────────────────────────────────────────────────────────────
const DIR      = STATE_DIR;
const LOG_FILE = path.join(DIR, 'reclamation-log.json');

// ── Credentials ─────────────────────────────────────────────────────────────
const AHREFS_TOKEN  = process.env.AHREFS_API_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GMAIL_USER    = process.env.GMAIL_USER;
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD;

// Outreach mailbox: reclamation emails are written to go from here
const PR_SMTP_HOST  = process.env.OUTREACH_SMTP_HOST;
const PR_SMTP_PORT  = parseInt(process.env.OUTREACH_SMTP_PORT || '587', 10);
const PR_SMTP_USER  = process.env.OUTREACH_SMTP_USER;
const PR_SMTP_PASS  = process.env.OUTREACH_SMTP_PASS;
const PR_FROM_EMAIL = process.env.OUTREACH_FROM_EMAIL || PR_SMTP_USER;
const PR_FROM_NAME  = process.env.SENDER_NAME || brand.senderName;

// Brand identity (config/brand.json)
const SITE_DOMAIN   = brand.domain;
const BRAND_TERMS   = brand.terms.map(t => t.toLowerCase());
const escapeRe      = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DOMAIN_RE     = new RegExp(escapeRe(SITE_DOMAIN), 'i');
const LINK_RE       = new RegExp(`<a[^>]+href[^>]*${escapeRe(SITE_DOMAIN)}`, 'i');
const MENTION_RE    = new RegExp(BRAND_TERMS.map(escapeRe).join('|'), 'i');
const LINK_LIST     = brand.allowedLinks.map(u => `- ${u}`).join('\n');
const RULES         = (brand.contentRules || []).join(' ');

// Pure check used by checkIfLinked(): does this HTML link to us, and does it mention us?
function classifyBody(body) {
  return { linked: DOMAIN_RE.test(body) && LINK_RE.test(body), mentioned: MENTION_RE.test(body) };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch { return { broken: {}, unlinked: {} }; }
}
function saveLog(data) { fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2)); }

async function fetchUrl(url, timeout = 10000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkReclamation/1.0)', 'Accept': 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: '' };
  }
}

// ── Ahrefs REST API (with retry) ────────────────────────────────────────────
async function ahrefsCall(endpoint, params, retries = 3) {
  if (!AHREFS_TOKEN) throw new Error('AHREFS_API_TOKEN not set');
  const url = new URL(`https://api.ahrefs.com/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${AHREFS_TOKEN}`, 'Accept': 'application/json' },
    });
    if (resp.ok) return resp.json();
    const body = await resp.text().catch(() => '');
    if ([500, 502, 503, 429].includes(resp.status) && attempt < retries) {
      const wait = attempt * 5;
      console.log(`    Ahrefs ${resp.status}: retrying in ${wait}s (attempt ${attempt}/${retries})...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`Ahrefs ${endpoint} HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
}

// ── Ahrefs units pre-check (subscription endpoint is free) ──────────────────
const AHREFS_EST_COST = 400; // rough units needed for the broken-backlinks call below

async function ahrefsUnitsLeft() {
  try {
    const data = await ahrefsCall('subscription-info/limits-and-usage', {}, 1);
    const s = data.limits_and_usage || data;
    if (typeof s.units_limit_workspace === 'number' && typeof s.units_usage_workspace === 'number') {
      return {
        left: Math.max(0, s.units_limit_workspace - s.units_usage_workspace),
        resetDate: String(s.usage_reset_date || '').slice(0, 10) || 'next cycle',
      };
    }
  } catch { /* free endpoint; if unavailable, let the main call decide */ }
  return null;
}

// ── 1. BROKEN BACKLINKS (from Ahrefs) ───────────────────────────────────────
async function findBrokenBacklinks() {
  console.log('\n  🔗 Pulling broken backlinks from Ahrefs...\n');
  const log = loadLog();

  // Pre-flight: skip cleanly (not as an error) if the monthly units are gone
  const units = await ahrefsUnitsLeft();
  if (units && units.left < AHREFS_EST_COST) {
    console.log(`    ⏭️  Ahrefs skipped: ${units.left} API units left this cycle (resets ${units.resetDate}).`);
    console.log(`    Broken-backlink check resumes automatically after the reset.\n`);
    return [];
  }

  try {
    const data = await ahrefsCall('site-explorer/broken-backlinks', {
      target: SITE_DOMAIN,
      mode: 'subdomains',
      select: 'url_from,domain_rating_source,url_to,http_code,anchor,name_source,is_dofollow',
      order_by: 'domain_rating_source:desc',
      limit: 20,
    });

    const backlinks = data.backlinks || [];
    console.log(`    Ahrefs returned ${backlinks.length} broken backlinks\n`);

    // Filter: skip already-logged (seen in last 90 days or already emailed), skip low-value
    const results = [];
    for (const bl of backlinks) {
      const key = bl.url_from;
      const seen = log.broken[key];
      if (seen) {
        const daysAgo = (Date.now() - new Date(seen.checkedAt || 0).getTime()) / 86400000;
        if (seen.status === 'emailed' || daysAgo < 90) continue; // already handled / recently reported
      }
      if (bl.domain_rating_source < 5) continue; // too low value

      results.push({
        sourceUrl:    bl.url_from,
        sourceDomain: bl.name_source || new URL(bl.url_from).hostname,
        targetUrl:    bl.url_to,
        httpCode:     bl.http_code,
        dr:           bl.domain_rating_source,
        traffic:      0,
        anchor:       bl.anchor || '',
        dofollow:     bl.is_dofollow,
      });
    }

    console.log(`    ${results.length} new/actionable broken backlinks (after filtering)\n`);
    return results;
  } catch (err) {
    const msg = String(err.message || err);
    if (/units? limit|HTTP 403/i.test(msg)) {
      // Unit exhaustion is expected near end-of-cycle: log as a skip, not an error,
      // so the status dashboard doesn't flag the whole run.
      console.log(`    ⏭️  Ahrefs skipped: API unit limit reached. Resumes after the monthly reset.\n`);
    } else {
      console.log(`    ⚠️  Ahrefs broken-backlinks ERROR: ${msg.replace(/\s+/g, ' ').slice(0, 200)}`);
      console.log(`    Continuing with unlinked mentions only.\n`);
    }
    return [];
  }
}

// ── 2. UNLINKED MENTIONS (from Google Alert emails in Gmail) ────────────────
async function findUnlinkedMentions() {
  console.log('\n  📌 Checking Gmail for Google Alert mentions...\n');
  if (!GMAIL_PASS) {
    console.log('    No GMAIL_APP_PASSWORD: skipping mention check.\n');
    return [];
  }

  const Imap = require('imap');
  const log = loadLog();
  const mentionUrls = [];

  return new Promise((resolve) => {
    const imap = new Imap({
      user: GMAIL_USER,
      password: GMAIL_PASS,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    });

    imap.once('ready', () => {
      // Search for Google Alert emails
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return resolve([]); }

        // Search for Google Alert emails from the last 14 days
        const since = new Date();
        since.setDate(since.getDate() - 14);

        imap.search([
          ['FROM', 'googlealerts-noreply@google.com'],
          ['SINCE', since],
        ], (err, uids) => {
          if (err || !uids || uids.length === 0) {
            console.log(`    No Google Alert emails found in last 14 days.`);
            imap.end();
            return resolve([]);
          }

          console.log(`    Found ${uids.length} Google Alert emails\n`);

          const f = imap.fetch(uids, { bodies: '', struct: false });
          f.on('message', (msg) => {
            let rawBody = '';
            msg.on('body', (stream) => {
              stream.on('data', d => rawBody += d.toString());
              stream.on('end', () => {
                // Decode quoted-printable first: Google Alert emails soft-wrap lines
                // with "=\r\n" and encode chars as "=XX", which truncated URLs into
                // junk like "www.goo" before this fix.
                const decoded = rawBody
                  .replace(/=\r?\n/g, '')
                  .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

                // Prefer the real destination inside Google redirect wrappers
                // (https://www.google.com/url?...url=<target>&...)
                const targets = [];
                for (const m of decoded.match(/https?:\/\/www\.google\.com\/url\?[^"'\s<>]+/g) || []) {
                  try {
                    const u = new URL(m.replace(/&amp;/g, '&'));
                    const t = u.searchParams.get('url') || u.searchParams.get('q');
                    if (t && /^https?:\/\//.test(t)) targets.push(t);
                  } catch { /* skip malformed */ }
                }

                // Fallback: strict URL regex over the decoded body
                const urlRegex = /https?:\/\/(?!www\.google\.|mail\.google\.|alerts\.google\.|support\.google\.|accounts\.google\.)[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(?:\/[a-zA-Z0-9._~:/?#@!$&'()*+,;=-]*[a-zA-Z0-9/])?/g;
                const matches = targets.length > 0 ? targets : (decoded.match(urlRegex) || []);

                for (let url of matches) {
                  // Clean up URL (remove tracking params, trailing chars, HTML entities)
                  url = url.replace(/[&?]utm_[^&]+/g, '').replace(/[)>"\s;,]+$/, '').replace(/&amp;.*$/, '');

                  // Validate: must have a proper domain with at least one dot and a 2+ char TLD
                  const domain = url.replace(/https?:\/\//, '').split('/')[0].toLowerCase();
                  if (!domain.includes('.') || domain.length < 4) continue;
                  if (domain.endsWith('=') || domain.includes('=')) continue;

                  // Skip our own domains, social media, Google
                  if (BRAND_TERMS.some(t => domain.includes(t)) || domain.includes(SITE_DOMAIN)) continue;
                  if (domain.match(/google\.|facebook\.|twitter\.|reddit\.|instagram\.|youtube\.|bing\./)) continue;
                  if (domain.match(/gstatic|googleapis|cloudflare|cloudfront|cdn\./)) continue;
                  if (log.unlinked[url]) continue; // already processed

                  mentionUrls.push({ url, domain });
                }
              });
            });
          });

          f.once('end', () => {
            imap.end();

            // Deduplicate by domain
            const seen = new Set();
            const unique = mentionUrls.filter(m => {
              if (seen.has(m.domain)) return false;
              seen.add(m.domain);
              return true;
            });

            console.log(`    Extracted ${unique.length} unique mention URLs\n`);
            resolve(unique);
          });

          f.once('error', () => { imap.end(); resolve([]); });
        });
      });
    });

    imap.once('error', (err) => {
      console.log(`    IMAP error: ${err.message}`);
      resolve([]);
    });
    imap.connect();
  });
}

// Check if a page actually links to our domain
async function checkIfLinked(url) {
  try {
    const { body, status } = await fetchUrl(url);
    if (status >= 400) return { linked: false, pageExists: false };
    return { ...classifyBody(body), pageExists: true };
  } catch {
    return { linked: false, pageExists: false };
  }
}

// ── Draft outreach email ────────────────────────────────────────────────────
async function draftEmail(item, type) {
  if (!ANTHROPIC_KEY) return '(No API key: write email manually)';
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const signoff = `${PR_FROM_NAME} | ${brand.company} | ${SITE_DOMAIN}`;
  const prompt = type === 'broken'
    ? `Write a SHORT, polite email (80-100 words) from ${PR_FROM_NAME} at ${brand.company} (${SITE_DOMAIN}).
Their page at ${item.sourceUrl} (DR ${item.dr}) previously linked to our page ${item.targetUrl} but now returns HTTP ${item.httpCode}.
Ask if they can restore the link, or update it to one of our current pages:
${LINK_LIST}
Be brief, human, not pushy. ${RULES}
Sign off: ${signoff}
Return valid JSON: {"subject": "...", "body": "..."}`
    : `Write a SHORT, natural email (80-100 words) from ${PR_FROM_NAME} at ${brand.company} (${SITE_DOMAIN}).
The site at ${item.url} mentioned ${brand.company} but didn't link to us.
Ask if they'd be willing to add a link, framed as helpful context for their readers.
Suggest linking to one of these pages:
${LINK_LIST}
Be conversational, not pushy. ${RULES}
Sign off: ${signoff}
Return valid JSON: {"subject": "...", "body": "..."}`;

  const msg = await client.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const jsonMatch = msg.content[0].text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch { /* fallback */ }

  return { subject: `Quick question about a link: ${brand.company}`, body: msg.content[0].text };
}

// ── Build clean email report ────────────────────────────────────────────────
function buildReport(brokenLinks, unlinkedMentions) {
  const date = new Date().toLocaleDateString('en-CA');
  const totalActions = brokenLinks.length + unlinkedMentions.length;

  return `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;background:#f9f9f9">

<div style="background:#1a1a2e;color:white;padding:24px;border-radius:12px 12px 0 0">
  <h1 style="margin:0;font-size:22px">🔗 Link Reclamation Report</h1>
  <p style="margin:6px 0 0;opacity:0.8;font-size:14px">${date}: ${totalActions} opportunities found</p>
</div>

<div style="background:white;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:0">

<!-- SUMMARY -->
<div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap">
  <div style="flex:1;min-width:140px;background:#fff0f0;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:#e74c3c">${brokenLinks.length}</div>
    <div style="font-size:12px;color:#666;margin-top:4px">Broken Backlinks</div>
  </div>
  <div style="flex:1;min-width:140px;background:#f0f4ff;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:#3498db">${unlinkedMentions.length}</div>
    <div style="font-size:12px;color:#666;margin-top:4px">Unlinked Mentions</div>
  </div>
</div>

${brokenLinks.length > 0 ? `
<!-- BROKEN BACKLINKS -->
<h3 style="color:#e74c3c;border-bottom:2px solid #fce4e4;padding-bottom:8px;margin-top:0">❌ Broken Backlinks</h3>
<p style="color:#666;font-size:13px;margin-bottom:16px">Sites that linked to us but whose page is now broken. Action: email webmaster to fix or update the link.</p>

${brokenLinks.map((item, i) => `
<div style="border:1px solid #f0d0d0;border-radius:8px;margin-bottom:16px;overflow:hidden">
  <div style="background:#fff5f5;padding:12px 16px;border-bottom:1px solid #f0d0d0">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap">
      <strong style="font-size:14px">${i + 1}. ${item.sourceDomain}</strong>
      <span style="font-size:12px">
        <span style="background:#e74c3c;color:white;padding:2px 8px;border-radius:10px">HTTP ${item.httpCode}</span>
        <span style="background:#eee;padding:2px 8px;border-radius:10px;margin-left:4px">DR ${item.dr}</span>
        ${item.dofollow ? '<span style="background:#27ae60;color:white;padding:2px 8px;border-radius:10px;margin-left:4px">dofollow</span>' : ''}
      </span>
    </div>
  </div>
  <div style="padding:12px 16px;font-size:13px">
    <p style="margin:0 0 4px"><strong>Their page:</strong> <a href="${item.sourceUrl}" style="color:#3498db;word-break:break-all">${item.sourceUrl}</a></p>
    <p style="margin:0 0 4px"><strong>Was linking to:</strong> ${item.targetUrl}</p>
    ${item.anchor ? `<p style="margin:0 0 4px"><strong>Anchor text:</strong> "${item.anchor}"</p>` : ''}
    <p style="margin:0 0 12px"><strong>What to do:</strong> Email the webmaster → ask them to restore or update the link to a current page of ours.</p>
    ${item.contactEmail ? `<p style="margin:0 0 4px"><strong>Contact:</strong> ${item.contactEmail}</p>` : ''}
    ${item.draft ? `
    <div style="background:#fef9f0;padding:12px;border-radius:6px;border-left:3px solid #f39c12;margin-top:8px">
      <div style="font-size:11px;color:#999;margin-bottom:4px">DRAFT EMAIL: Subject: ${item.draft.subject}</div>
      <div style="white-space:pre-wrap;font-size:13px">${item.draft.body}</div>
    </div>` : ''}
  </div>
</div>`).join('')}
` : ''}

${unlinkedMentions.length > 0 ? `
<!-- UNLINKED MENTIONS -->
<h3 style="color:#3498db;border-bottom:2px solid #d6eaf8;padding-bottom:8px">📌 Unlinked Brand Mentions</h3>
<p style="color:#666;font-size:13px;margin-bottom:16px">Pages that mention the brand but don't link to us. Action: email the site owner to add a link.</p>

${unlinkedMentions.map((item, i) => `
<div style="border:1px solid #d0e0f0;border-radius:8px;margin-bottom:16px;overflow:hidden">
  <div style="background:#f5f9ff;padding:12px 16px;border-bottom:1px solid #d0e0f0">
    <strong style="font-size:14px">${i + 1}. ${item.domain}</strong>
  </div>
  <div style="padding:12px 16px;font-size:13px">
    <p style="margin:0 0 4px"><strong>Page:</strong> <a href="${item.url}" style="color:#3498db;word-break:break-all">${item.url}</a></p>
    <p style="margin:0 0 12px"><strong>What to do:</strong> Email site owner → ask them to add a link to ${SITE_DOMAIN} where they mentioned us.</p>
    ${item.contactEmail ? `<p style="margin:0 0 4px"><strong>Contact:</strong> ${item.contactEmail}</p>` : ''}
    ${item.draft ? `
    <div style="background:#eef7f0;padding:12px;border-radius:6px;border-left:3px solid #27ae60;margin-top:8px">
      <div style="font-size:11px;color:#999;margin-bottom:4px">DRAFT EMAIL: Subject: ${item.draft.subject}</div>
      <div style="white-space:pre-wrap;font-size:13px">${item.draft.body}</div>
    </div>` : ''}
  </div>
</div>`).join('')}
` : ''}

${totalActions === 0 ? `
<div style="text-align:center;padding:40px 20px;color:#999">
  <div style="font-size:48px;margin-bottom:12px">✅</div>
  <p style="font-size:16px;margin:0">No new reclamation opportunities this week.</p>
  <p style="font-size:13px;margin:8px 0 0">All existing backlinks are healthy.</p>
</div>
` : ''}

</div>

<p style="text-align:center;font-size:11px;color:#999;margin-top:16px">
  Link reclamation monitor, runs weekly<br>
  Broken backlinks from Ahrefs API | Mentions from Google Alerts
</p>

</body></html>`;
}

// ── Contact finder (reuse pattern from other scripts) ───────────────────────
function extractEmails(html, domain) {
  const all = [...new Set((html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || []))];
  return all.filter(e =>
    !e.match(/noreply|no-reply|support@shopify|sentry|example\.com|w3\.org|unsubscribe|bounce|donotreply/i)
  ).filter(e => {
    let score = 0;
    if (e.toLowerCase().includes(domain)) score += 10;
    if (e.match(/contact|hello|hi@|team@|editor|webmaster|admin@|info@/i)) score += 5;
    return score > 0;
  });
}

async function findContactEmail(domain) {
  const base = `https://${domain}`;
  for (const p of ['', '/contact', '/about', '/contact-us']) {
    try {
      const { body } = await fetchUrl(`${base}${p}`);
      const emails = extractEmails(body, domain);
      if (emails.length > 0) return emails[0];
    } catch { /* skip */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍  Link Reclamation Monitor  [${new Date().toISOString()}]\n`);

  const log = loadLog();
  let brokenLinks = [];
  let unlinkedMentions = [];

  // Step 1: Broken backlinks from Ahrefs
  if (!MENTIONS_ONLY) {
    brokenLinks = await findBrokenBacklinks();
  }

  // Step 2: Unlinked mentions from Google Alert emails
  if (!BROKEN_ONLY) {
    const rawMentions = await findUnlinkedMentions();

    // Verify each mention: check if the page actually mentions us without linking
    console.log('  🔎 Verifying mention pages...\n');
    for (const mention of rawMentions.slice(0, 15)) { // cap at 15 checks per run
      const check = await checkIfLinked(mention.url);
      if (check.pageExists && check.mentioned && !check.linked) {
        unlinkedMentions.push(mention);
        console.log(`    ✅ Confirmed unlinked mention: ${mention.domain}`);
      } else if (check.linked) {
        console.log(`    ⏭️  Already linked: ${mention.domain}`);
      } else {
        console.log(`    ⏭️  Not a real mention: ${mention.domain}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`\n    ${unlinkedMentions.length} confirmed unlinked mentions\n`);
  }

  const totalOpportunities = brokenLinks.length + unlinkedMentions.length;
  console.log(`\n📊 Summary: ${brokenLinks.length} broken backlinks + ${unlinkedMentions.length} unlinked mentions = ${totalOpportunities} opportunities\n`);

  // Step 3: Find contact emails + draft outreach for top opportunities
  if (totalOpportunities > 0) {
    console.log('  📧 Finding contacts and drafting emails...\n');

    // Process broken backlinks (all of them: high value)
    for (const item of brokenLinks) {
      const domain = item.sourceDomain.replace('www.', '');
      item.contactEmail = await findContactEmail(domain);
      if (item.contactEmail || true) { // draft even without contact email
        item.draft = await draftEmail(item, 'broken');
      }
      await new Promise(r => setTimeout(r, 600));
    }

    // Process unlinked mentions (top 10)
    for (const item of unlinkedMentions.slice(0, 10)) {
      item.contactEmail = await findContactEmail(item.domain.replace('www.', ''));
      item.draft = await draftEmail(item, 'mention');
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // Step 4: Build and send report
  const reportHtml = buildReport(brokenLinks, unlinkedMentions);

  if (DRY_RUN) {
    console.log('\n── DRY RUN: no email sent, no log updated ──');
    brokenLinks.forEach(i => console.log(`  ❌ BROKEN: ${i.sourceUrl} → ${i.httpCode}`));
    unlinkedMentions.forEach(i => console.log(`  📌 MENTION: ${i.url}`));
    console.log('\n');
    return;
  }

  // Update log
  for (const item of brokenLinks) {
    log.broken[item.sourceUrl] = {
      checkedAt: new Date().toISOString(),
      httpCode: item.httpCode,
      dr: item.dr,
      targetUrl: item.targetUrl,
      contactEmail: item.contactEmail,
      status: 'found',
    };
  }
  for (const item of unlinkedMentions) {
    log.unlinked[item.url] = {
      foundAt: new Date().toISOString(),
      domain: item.domain,
      contactEmail: item.contactEmail,
      status: 'found',
    };
  }
  saveLog(log);

  // Send report email via Gmail (this is a report TO you, not outreach)
  if (GMAIL_PASS) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });
    const date = new Date().toLocaleDateString('en-CA');
    await transporter.sendMail({
      from:    `"${brand.company} Link Reclamation" <${GMAIL_USER}>`,
      to:      GMAIL_USER,
      subject: `[${brand.company} | Report] Link Reclamation: ${brokenLinks.length} broken, ${unlinkedMentions.length} mentions: ${date}`,
      html:    reportHtml,
    });
    console.log(`\n✅  Report emailed to ${GMAIL_USER}\n`);
  }

  console.log(`📊  Done. ${totalOpportunities} opportunities logged.\n`);
}

if (require.main === module) {
  main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
}

module.exports = { classifyBody };
