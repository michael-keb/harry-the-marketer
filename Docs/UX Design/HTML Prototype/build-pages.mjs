#!/usr/bin/env node
/**
 * Generates static HTML prototype pages from the WYRE screen inventory.
 * Run: node build-pages.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGES = join(ROOT, 'pages');

function shell(title, sidebar, body, modals = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Harry</title>
  <link rel="stylesheet" href="../css/harry.css">
</head>
<body>
  <div class="app">
    ${sidebar}
    <div class="main">
      ${body}
    </div>
  </div>
  ${modals}
  <script src="../js/harry.js"></script>
</body>
</html>`;
}

function sideNav(active, links = '') {
  const items = [
    ['Dashboard', 'analytics-dashboard.html'],
    ['Reports', 'analytics-reports.html'],
    ['Campaigns', 'campaigns-list.html'],
    ['Leads', 'leads-list.html'],
    ['Inbox', 'inbox-replies.html'],
    ['Mailboxes', 'mailboxes.html'],
    ['Monitoring', 'deliverability.html'],
    ['Settings', 'settings-block-list.html'],
  ];
  const nav = items.map(([label, href]) =>
    `<a href="${href}"${active === label ? ' class="active"' : ''}>${label}</a>`
  ).join('\n        ');
  return `<aside class="sidebar">
      <h3><a href="../index.html">Harry</a></h3>
      <nav>
        ${nav}
        ${links}
      </nav>
    </aside>`;
}

function topbar(inner) {
  return `<header class="topbar">${inner}<div class="avatar">MC</div></header>`;
}

mkdirSync(PAGES, { recursive: true });

const files = {};

// --- analytics ---
files['analytics-reports.html'] = shell('Reports', sideNav('Reports'), `
      ${topbar('<span class="breadcrumb">Reports</span><input type="date" value="2026-05-01" style="width:auto"> – <input type="date" value="2026-05-07" style="width:auto">')}
      <div class="content">
        <div class="row between">
          <div><h1>Outreach overview</h1><p class="caption">Same numbers as Dashboard for this range</p></div>
          <div class="segmented"><button class="active">7 days</button><button>30 days</button><button>90 days</button></div>
        </div>
        <div class="row" style="margin-top:1rem">
          <div class="card"><div class="stat-label">Emails sent</div><div class="stat-value">12,480</div><p class="caption">+8% vs prior period</p></div>
          <div class="card"><div class="stat-label">Replies</div><div class="stat-value">842</div><p class="caption">6.7% reply rate</p></div>
          <div class="card"><div class="stat-label">Positive replies</div><div class="stat-value">218</div><p class="caption">26% of replies</p></div>
          <div class="card"><div class="stat-label">Mailbox health</div><div class="stat-value">Good</div></div>
        </div>
        <div data-tabs style="margin-top:1.5rem">
          <div class="tabs"><button class="tab active">Campaigns</button><button class="tab">Mailboxes</button><button class="tab">By day</button></div>
          <div class="tab-panel active"><table><thead><tr><th>Campaign</th><th>Sent</th><th>Replies</th><th>Positive</th><th>Status</th></tr></thead>
          <tbody><tr><td><a href="campaign-detail.html">Q1 Cold Outreach</a></td><td>4,820</td><td>312</td><td>84</td><td><span class="badge badge-success">Running</span></td></tr>
          <tr><td>Partner nurture</td><td>2,100</td><td>98</td><td>31</td><td><span class="badge badge-success">Running</span></td></tr></tbody></table></div>
          <div class="tab-panel"><table><thead><tr><th>Mailbox</th><th>Provider</th><th>Sent</th><th>Bounce</th><th>Health</th></tr></thead>
          <tbody><tr><td>sarah@acme.io</td><td>Google</td><td>1,240</td><td>0.4%</td><td><span class="badge badge-success">Good</span></td></tr></tbody></table></div>
          <div class="tab-panel"><p class="caption">Chart: daily replies over selected range</p><div class="card" style="height:200px;display:flex;align-items:center;justify-content:center;color:var(--muted)">Line chart placeholder</div></div>
        </div>
      </div>`);

files['analytics-dashboard.html'] = shell('Dashboard', sideNav('Dashboard'), `
      ${topbar('<h2>Dashboard</h2>')}
      <div class="content">
        <div class="row">
          <div class="card"><div class="stat-label">Emails sent</div><div class="stat-value">12,480</div></div>
          <div class="card"><div class="stat-label">Replies</div><div class="stat-value">842</div></div>
          <div class="card"><div class="stat-label">Positive</div><div class="stat-value">218</div></div>
        </div>
        <p class="caption" style="margin-top:1rem">KPI tiles read from the same aggregate as Reports — one date range, one truth.</p>
      </div>`);

files['campaign-detail.html'] = shell('Q1 Cold Outreach', sideNav('Campaigns'), `
      ${topbar('<span class="breadcrumb">Campaigns / Q1 Cold Outreach</span><button class="btn btn-ghost">Pause campaign</button>')}
      <div class="content">
        <h1>Q1 Cold Outreach <span class="badge badge-success">Running</span></h1>
        <div class="row" style="margin-top:1rem">
          <div class="card"><div class="stat-label">Sent</div><div class="stat-value">4,820</div></div>
          <div class="card"><div class="stat-label">Opens</div><div class="stat-value">38%</div></div>
          <div class="card"><div class="stat-label">Replies</div><div class="stat-value">312</div></div>
          <div class="card"><div class="stat-label">Positive</div><div class="stat-value">84</div></div>
        </div>
        <div data-tabs style="margin-top:1.5rem">
          <div class="tabs"><button class="tab active">Playbook</button><button class="tab">Leads</button><button class="tab">Stats</button></div>
          <div class="tab-panel active"><p>Mermaid editor and readiness strip live here in the product.</p></div>
          <div class="tab-panel"><table><thead><tr><th>Lead</th><th>Stage</th><th>Last activity</th></tr></thead>
          <tbody><tr><td><a href="lead-detail.html">Priya Sharma</a></td><td><span class="badge badge-success">Interested</span></td><td>2h ago</td></tr></tbody></table></div>
          <div class="tab-panel"><div class="card" style="height:160px;display:flex;align-items:center;justify-content:center;color:var(--muted)">Bar chart placeholder</div>
          <p class="caption">Mailbox with most sends: sarah@acme.io · Slowest first reply: 4.2 days</p></div>
        </div>
      </div>`);

files['campaigns-list.html'] = shell('Campaigns', sideNav('Campaigns'), `
      ${topbar('<h2>Campaigns</h2><button class="btn btn-primary" data-open="modal-new">New campaign</button>')}
      <div class="content">
        <table><thead><tr><th>Campaign</th><th>Status</th><th>Sent</th><th>Replies</th><th>Updated</th></tr></thead>
        <tbody>
          <tr><td><a href="campaign-detail.html">Q1 Cold Outreach</a></td><td><span class="badge badge-success">Running</span></td><td>4,820</td><td>312</td><td>Today</td></tr>
          <tr><td><a href="campaign-editor.html">Untitled campaign</a></td><td><span class="badge">Draft</span></td><td>—</td><td>—</td><td>Today</td></tr>
        </tbody></table>
      </div>`,
  `<div id="modal-new" class="modal-backdrop hidden"><div class="modal"><h3>New campaign</h3><div class="field"><label>Name (optional)</label><input placeholder="Q1 Cold Outreach"></div><div class="modal-actions"><a href="campaign-editor.html" class="btn btn-primary">Create</a><button class="btn btn-ghost" data-close="modal-new">Cancel</button></div></div></div>`);

files['campaign-editor.html'] = shell('Untitled campaign', sideNav('Campaigns'), `
      ${topbar('<span class="breadcrumb">Campaigns / Untitled campaign</span><button class="btn btn-primary" data-open="modal-launch">Launch</button>')}
      <div class="content">
        <div class="callout callout-warning">Launch needs: valid playbook · mailbox · leads</div>
        <div class="row">
          <div class="card"><h3>Playbook</h3><span class="badge badge-error">Missing</span></div>
          <div class="card"><h3>Mailbox</h3><span class="badge badge-error">Missing</span></div>
          <div class="card"><h3>Leads</h3><span class="badge badge-error">Missing</span></div>
        </div>
        <section style="margin-top:1.5rem"><h2>Playbook</h2><p>Starter Mermaid diagram opens here after create.</p></section>
      </div>`,
  `<div id="modal-launch" class="modal-backdrop hidden"><div class="modal"><h3>Launch campaign?</h3><p>Drafts go to Inbox → Needs your OK. Nothing sends without your approval.</p><div class="modal-actions"><a href="inbox-needs-ok.html" class="btn btn-primary">Launch</a><button class="btn btn-ghost" data-close="modal-launch">Cancel</button></div></div></div>`);

files['inbox-needs-ok.html'] = shell('Needs your OK', sideNav('Inbox'), `
      ${topbar('<h2>Inbox · Needs your OK</h2>')}
      <div class="content">
        <a href="inbox-thread.html" class="list-card"><strong>Priya Sharma</strong><br><span class="caption">Re: pricing for 50 seats</span><br><button class="btn btn-primary btn-sm" style="margin-top:0.5rem">Review draft</button></a>
        <a href="inbox-thread.html" class="list-card"><strong>James Wu</strong><br><span class="caption">Follow-up on demo request</span></a>
        <a href="inbox-thread.html" class="list-card"><strong>Sofia Mendez</strong><br><span class="caption">Re: integration timeline</span></a>
      </div>`);

files['clients-settings.html'] = shell('Clients', sideNav('Settings', `
        <hr><p class="caption">Agency workspace</p>
        <a href="clients-settings.html" class="active">Clients</a>
        <a href="settings-block-list.html">Block list</a>
        <a href="settings-webhooks.html">Webhooks</a>`), `
      ${topbar('<select style="width:auto"><option>Acme Agency</option><option>Northwind Brand</option></select>')}
      <div class="content">
        <div class="row between"><div><h1>Client workspaces</h1><p class="caption">Each brand has separate leads, campaigns and inbox.</p></div>
        <button class="btn btn-primary" data-open="modal-client">New client</button></div>
        <div class="row" style="margin-top:1rem">
          <div class="card"><h3>Acme Agency</h3><p class="caption">admin@acme.com</p><div class="taglist"><span class="badge">Campaigns</span><span class="badge">Leads</span></div><p class="caption">10,000 emails · 5,000 leads</p></div>
          <div class="card"><h3>Northwind Brand</h3><p class="caption">ops@northwind.io</p><div class="taglist"><span class="badge">Campaigns</span><span class="badge">Inbox</span></div></div>
        </div>
      </div>`,
  `<div id="modal-client" class="modal-backdrop hidden"><div class="modal"><h3>New client</h3>
    <div class="field"><label>Name</label><input value="Acme Agency"></div>
    <div class="field"><label>Contact email</label><input value="admin@acme.com"></div>
    <p class="caption">Permissions: Campaigns, Leads (Auth0 sign-in — no password)</p>
    <div class="modal-actions"><button class="btn btn-primary" data-close="modal-client">Create client</button><button class="btn btn-ghost" data-close="modal-client">Cancel</button></div></div></div>`);

files['mailboxes-bulk-tags.html'] = shell('Mailboxes · Tags', sideNav('Mailboxes'), `
      ${topbar('<h2>Mailboxes</h2><button class="btn btn-ghost">Add mailbox</button>')}
      <div class="content">
        <div class="row between" style="margin-bottom:1rem"><input placeholder="Search mailboxes" style="max-width:240px"><select style="width:auto"><option>All tags</option><option>Warmup</option></select>
        <button class="btn btn-primary" data-open="modal-tag">Tag selected</button></div>
        <table><thead><tr><th></th><th>Mailbox</th><th>Provider</th><th>Health</th><th>Tags</th></tr></thead>
        <tbody><tr><td><input type="checkbox" checked></td><td><a href="mailbox-detail.html">sarah@acme.io</a></td><td>Google</td><td><span class="badge badge-success">Good</span></td><td>Warmup, Production</td></tr>
        <tr><td><input type="checkbox"></td><td>alex@acme.io</td><td>Google</td><td><span class="badge badge-success">Good</span></td><td>Sandbox</td></tr></tbody></table>
        <p class="caption" style="margin-top:0.5rem">Multi-select stays quiet until rows are checked.</p>
      </div>`,
  `<div id="modal-tag" class="modal-backdrop hidden"><div class="modal"><h3>Tag mailboxes</h3><div class="field"><label>Tags</label><input value="Warmup, Production"></div><div class="modal-actions"><button class="btn btn-primary" data-close="modal-tag">Apply tags</button><button class="btn btn-ghost" data-close="modal-tag">Cancel</button></div></div></div>`);

files['mailboxes.html'] = shell('Mailboxes', sideNav('Mailboxes'), `
      ${topbar('<button class="btn btn-primary" data-open="modal-add">Add mailbox</button><a href="buy-senders.html" class="btn btn-ghost">Buy senders</a>')}
      <div class="content">
        <div class="row between" style="margin-bottom:1rem"><input placeholder="Search mailboxes" style="max-width:240px"><select style="width:auto"><option>All</option><option>Suspended</option></select></div>
        <table><thead><tr><th>Mailbox</th><th>Sent today</th><th>Limit</th><th>Warmup</th><th>Health</th></tr></thead>
        <tbody><tr><td><a href="mailbox-detail.html">sarah@acme.io</a></td><td>42</td><td>50 / 50</td><td><span class="badge badge-success">Active</span></td><td><span class="badge badge-success">Good</span></td></tr>
        <tr><td>alex@acme.io</td><td>18</td><td>50 / 50</td><td><span class="badge">Off</span></td><td><span class="badge badge-success">Good</span></td></tr></tbody></table>
      </div>`,
  `<div id="modal-add" class="modal-backdrop hidden"><div class="modal"><h3>Add mailbox</h3><button class="btn btn-primary" style="width:100%">Connect Google</button><div class="modal-actions"><button class="btn btn-ghost" data-close="modal-add">Cancel</button></div></div></div>`);

files['mailbox-detail.html'] = shell('sarah@acme.io', sideNav('Mailboxes'), `
      ${topbar('<span class="breadcrumb">Mailboxes / sarah@acme.io</span><button class="btn btn-danger" data-open="modal-suspend">Suspend</button>')}
      <div class="content">
        <div class="row"><div class="card"><div class="stat-label">Sent today</div><div class="stat-value">42</div></div>
        <div class="card"><div class="stat-label">Warmup score</div><div class="stat-value">92%</div></div></div>
        <section style="margin-top:1.5rem"><h2>Warmup settings</h2>
        <label><input type="checkbox" checked> Warmup enabled</label>
        <div class="field" style="margin-top:0.75rem"><label>Daily warmup cap</label><input value="20"></div></section>
      </div>`,
  `<div id="modal-suspend" class="modal-backdrop hidden"><div class="modal"><h3>Suspend mailbox?</h3><p>This mailbox stops sending until you unsuspend it.</p><div class="modal-actions"><button class="btn btn-danger" data-close="modal-suspend">Suspend</button><button class="btn btn-ghost" data-close="modal-suspend">Cancel</button></div></div></div>`);

files['inbox-replies.html'] = shell('Inbox', sideNav('Inbox', `
        <a href="inbox-needs-ok.html">Needs your OK</a>
        <a href="#">Unread</a>`), `
      ${topbar('<input placeholder="Search replies (30 max)" style="flex:1;max-width:280px"><button class="btn btn-ghost">Filters <span class="badge">2</span></button>')}
      <div class="content">
        <div class="split">
          <div class="split-list">
            <p class="caption">Showing 20 of 248</p>
            <a href="inbox-thread.html" class="list-card active"><strong>Priya Sharma</strong> <span class="badge badge-success">Interested</span><br><span class="caption">Startup Inc</span><br>Can you share pricing for 50 seats…<br><span class="caption">2h ago</span></a>
            <a href="inbox-thread.html" class="list-card"><strong>James Wu</strong><br><span class="caption">Not now</span><br>Thanks, not a fit right now.<br><span class="caption">5h ago</span></a>
          </div>
          <div class="split-detail empty"><p>Select a reply</p><p class="caption">Open a thread to read history and respond.</p></div>
        </div>
      </div>`);

files['inbox-thread.html'] = shell('Thread', sideNav('Inbox'), `
      ${topbar('<span class="breadcrumb"><a href="inbox-replies.html">Inbox</a> / Priya Sharma</span><button class="btn btn-primary" data-open="modal-reply">Reply</button>')}
      <div class="content">
        <h2>Re: pricing for 50 seats <span class="badge badge-success">Interested</span></h2>
        <p class="caption">Q1 Cold Outreach · sarah@acme.io</p>
        <div data-tabs style="margin-top:1rem">
          <div class="tabs"><button class="tab active">Messages</button><button class="tab">Notes</button><button class="tab">Tasks</button></div>
          <div class="tab-panel active"><div class="chat-in"><strong>Priya Sharma</strong><br>Can you share pricing for 50 seats before we book a call?</div></div>
          <div class="tab-panel"><div class="callout callout-info">Internal only — never emailed to the prospect.</div>
          <div class="list-card">Called Priya — wants pricing before any call.<br><span class="caption">Maya Chen · yesterday</span></div>
          <textarea placeholder="Add internal note" style="margin-top:0.5rem"></textarea><button class="btn btn-primary btn-sm">Save note</button></div>
          <div class="tab-panel"><div class="list-card">Send pricing one-pager<br><span class="caption">Due tomorrow · Maya</span></div><button class="btn btn-primary btn-sm">Add task</button></div>
        </div>
      </div>`,
  `<div id="modal-reply" class="modal-backdrop hidden"><div class="modal"><h3>Send reply?</h3><textarea placeholder="Your reply"></textarea><p class="caption">Nothing sends until you confirm.</p><div class="modal-actions"><button class="btn btn-primary" data-close="modal-reply">Send</button><button class="btn btn-ghost" data-close="modal-reply">Cancel</button></div></div></div>`);

files['lead-lists.html'] = shell('Segments', sideNav('Leads'), `
      ${topbar('<h2>Leads · Segments</h2><button class="btn btn-primary" data-open="modal-segment">New segment</button>')}
      <div class="content">
        <div class="split">
          <div class="split-list">
            <a href="#" class="list-card active"><strong>Enterprise Q1</strong><br><span class="caption">842 leads</span></a>
            <a href="#" class="list-card"><strong>Partner list</strong><br><span class="caption">120 leads</span></a>
          </div>
          <div style="flex:1">
            <div class="row between"><h2>Enterprise Q1</h2><button class="btn btn-primary" data-open="modal-push">Push to campaign</button></div>
            <table style="margin-top:1rem"><thead><tr><th>Name</th><th>Company</th><th>Email</th></tr></thead>
            <tbody><tr><td>Priya Sharma</td><td>Startup Inc</td><td>priya@startup.io</td></tr></tbody></table>
          </div>
        </div>
      </div>`,
  `<div id="modal-segment" class="modal-backdrop hidden"><div class="modal"><h3>New segment</h3><input placeholder="Segment name"><div class="modal-actions"><button class="btn btn-primary" data-close="modal-segment">Create</button><button class="btn btn-ghost" data-close="modal-segment">Cancel</button></div></div></div>
  <div id="modal-push" class="modal-backdrop hidden"><div class="modal"><h3>Push to campaign</h3><select><option>Q1 Cold Outreach</option></select><p class="caption">Campaign must already exist with playbook and mailbox.</p><div class="modal-actions"><button class="btn btn-primary" data-close="modal-push">Push leads</button><button class="btn btn-ghost" data-close="modal-push">Cancel</button></div></div></div>`);

files['lead-detail-notes.html'] = shell('Priya Sharma · Notes', sideNav('Leads'), `
      ${topbar('<span class="breadcrumb">Leads / Priya Sharma</span>')}
      <div class="content">
        <div class="split">
          <div style="flex:2">
            <h2>Profile</h2><p>Startup Inc · priya@startup.io</p>
            <h3 style="margin-top:1rem">Activity</h3><p class="caption">Replied · Q1 Cold Outreach · yesterday</p>
          </div>
          <div style="flex:1">
            <div class="callout callout-info">Internal only — never emailed to the prospect.</div>
            <div class="list-card">Called Priya — wants pricing for 50 seats.<br><span class="caption">Maya Chen · yesterday</span></div>
            <textarea placeholder="What happened off-email?" style="margin-top:0.5rem"></textarea>
            <button class="btn btn-primary btn-sm" style="margin-top:0.5rem">Save note</button>
          </div>
        </div>
      </div>`);

files['leads-list-tags.html'] = shell('Leads · Labels', sideNav('Leads'), `
      ${topbar('<input placeholder="Search leads" style="flex:1;max-width:280px"><button class="btn btn-primary" data-open="modal-label">Add label</button>')}
      <div class="content">
        <p class="caption">3 selected</p>
        <table><thead><tr><th></th><th>Name</th><th>Company</th><th>Stage</th><th>Labels</th></tr></thead>
        <tbody><tr><td><input type="checkbox" checked></td><td><a href="lead-detail-tags.html">Priya Sharma</a></td><td>Startup Inc</td><td><span class="badge">Replied</span></td><td>Enterprise, Hot</td></tr></tbody></table>
      </div>`,
  `<div id="modal-label" class="modal-backdrop hidden"><div class="modal"><h3>Add label</h3><input placeholder="Pick or create label"><div class="modal-actions"><button class="btn btn-primary" data-close="modal-label">Apply</button><button class="btn btn-ghost" data-close="modal-label">Cancel</button></div></div></div>`);

files['lead-detail-tags.html'] = shell('Priya Sharma · Labels', sideNav('Leads'), `
      ${topbar('<span class="breadcrumb">Leads / Priya Sharma</span><button class="btn btn-primary" data-open="modal-label">Add label</button>')}
      <div class="content">
        <h2>Priya Sharma</h2>
        <div class="taglist"><span class="badge">Enterprise</span><span class="badge">Hot</span><span class="badge">+ Add</span></div>
      </div>`,
  `<div id="modal-label" class="modal-backdrop hidden"><div class="modal"><h3>Add label</h3><input><div class="modal-actions"><button class="btn btn-primary" data-close="modal-label">Apply</button></div></div></div>`);

files['inbox-thread-task.html'] = shell('Thread · Task', sideNav('Inbox'), `
      ${topbar('<span class="breadcrumb">Inbox / Priya Sharma</span>')}
      <div class="content">
        <div class="chat-in">Can you share pricing for 50 seats?</div>
        <button class="btn btn-primary" data-open="modal-task">Add task</button>
        <a href="lead-detail-notes.html" class="btn btn-ghost">Add note</a>
      </div>`,
  `<div id="modal-task" class="modal-backdrop hidden"><div class="modal"><h3>Follow-up task</h3>
    <input value="Send pricing one-pager"><input type="date"><select><option>Maya Chen</option></select>
    <div class="modal-actions"><a href="action-center.html" class="btn btn-primary">Create task</a><button class="btn btn-ghost" data-close="modal-task">Cancel</button></div></div></div>`);

files['action-center.html'] = shell('Action Center', sideNav('Dashboard'), `
      ${topbar('<h2>Action Center</h2>')}
      <div class="content">
        <p class="caption">Human work lives here — not a separate Tasks app.</p>
        <div data-tabs>
          <div class="tabs"><button class="tab active">Drafts to approve</button><button class="tab">Tasks</button></div>
          <div class="tab-panel active"><a href="inbox-needs-ok.html" class="list-card">Reply to Priya Sharma <button class="btn btn-primary btn-sm">Review</button></a></div>
          <div class="tab-panel"><div class="list-card row between"><div>Send pricing one-pager<br><span class="caption">Priya Sharma · due tomorrow</span></div><button class="btn btn-primary btn-sm">Done</button></div></div>
        </div>
      </div>`);

files['leads-list.html'] = shell('Leads', sideNav('Leads', `
        <a href="lead-lists.html">Segments</a>
        <a href="find-prospects.html">Find prospects</a>`), `
      ${topbar('<input placeholder="Search leads" style="flex:1;max-width:280px"><button class="btn btn-ghost">Export</button>')}
      <div class="content">
        <div class="segmented" style="margin-bottom:1rem"><button class="active">All</button><button>Replied</button><button>Paused</button></div>
        <table><thead><tr><th>Name</th><th>Company</th><th>Campaign</th><th>Stage</th><th>Last activity</th></tr></thead>
        <tbody><tr><td><a href="lead-detail.html">Priya Sharma</a></td><td>Startup Inc</td><td>Q1 Cold Outreach</td><td><span class="badge badge-success">Interested</span></td><td>2h ago</td></tr></tbody></table>
      </div>`);

files['lead-detail.html'] = shell('Priya Sharma', sideNav('Leads'), `
      ${topbar('<span class="breadcrumb">Leads / Priya Sharma</span>')}
      <div class="content">
        <div class="row between"><h2>Priya Sharma</h2><div><button class="btn btn-ghost">Pause</button> <button class="btn btn-danger" data-open="modal-unsub">Unsubscribe</button></div></div>
        <p>priya@startup.io · Interested</p>
        <table style="margin-top:1rem"><thead><tr><th>Campaign</th><th>Stage</th><th>Actions</th></tr></thead>
        <tbody><tr><td>Q1 Cold Outreach</td><td><span class="badge badge-success">Replied</span></td><td><a href="inbox-thread.html">View thread</a></td></tr></tbody></table>
      </div>`,
  `<div id="modal-unsub" class="modal-backdrop hidden"><div class="modal"><h3>Unsubscribe globally?</h3><p>Harry will never email this person again.</p><div class="modal-actions"><button class="btn btn-danger" data-close="modal-unsub">Unsubscribe</button><button class="btn btn-ghost" data-close="modal-unsub">Cancel</button></div></div></div>`);

files['deliverability.html'] = shell('Deliverability', sideNav('Monitoring'), `
      ${topbar('<h2>Monitoring · Deliverability</h2><button class="btn btn-primary" data-open="modal-test">Run test</button>')}
      <div class="content">
        <div class="split">
          <div class="split-list">
            <div class="list-card active"><strong>All tests</strong><br><span class="caption">3 tests</span></div>
            <div class="list-card"><strong>Production domains</strong><br><span class="caption">1 test</span></div>
          </div>
          <div style="flex:1">
            <table><thead><tr><th>Test</th><th>Type</th><th>Status</th><th>Cadence</th><th>Last run</th></tr></thead>
            <tbody><tr><td><a href="test-detail.html">Weekly inbox check</a></td><td>Automated</td><td><span class="badge badge-success">Active</span></td><td>Every 7 days, run 8</td><td>Today 09:00</td></tr>
            <tr><td><a href="test-detail.html">Launch smoke test</a></td><td>Manual</td><td><span class="badge">Completed</span></td><td>—</td><td>Yesterday</td></tr></tbody></table>
          </div>
        </div>
      </div>`,
  `<div id="modal-test" class="modal-backdrop hidden"><div class="modal"><h3>Run placement test</h3><select><option>Manual</option><option>Automated</option></select><input placeholder="Test name"><div class="modal-actions"><a href="test-detail.html" class="btn btn-primary">Start</a><button class="btn btn-ghost" data-close="modal-test">Cancel</button></div></div></div>`);

files['test-detail.html'] = shell('Weekly inbox check', sideNav('Monitoring'), `
      ${topbar('<span class="breadcrumb">Deliverability / Weekly inbox check</span><button class="btn btn-ghost">Stop test</button>')}
      <div class="content">
        <div class="row"><div class="card"><div class="stat-label">Inbox rate</div><div class="stat-value">94%</div></div>
        <div class="card"><div class="stat-label">Spam rate</div><div class="stat-value">4%</div></div>
        <div class="card"><div class="stat-label">Missing</div><div class="stat-value">2%</div></div></div>
        <div data-tabs style="margin-top:1rem">
          <div class="tabs"><button class="tab active">Providers</button><button class="tab">Authentication</button><button class="tab">Blocklists</button></div>
          <div class="tab-panel active"><table><thead><tr><th>Provider</th><th>Inbox</th><th>Spam</th><th>Missing</th></tr></thead>
          <tbody><tr><td>Gmail</td><td>96%</td><td>3%</td><td>1%</td></tr></tbody></table></div>
          <div class="tab-panel"><p>SPF <span class="badge badge-success">Pass</span> · DKIM <span class="badge badge-success">Pass</span></p></div>
          <div class="tab-panel"><table><tr><td>Domain blacklist</td><td><span class="badge badge-success">Clear</span></td></tr></tbody></table></div>
        </div>
      </div>`);

files['find-prospects.html'] = shell('Find prospects', sideNav('Leads'), `
      ${topbar('<h2>Find prospects</h2>')}
      <div class="content">
        <div class="split">
          <div style="flex:1">
            <h3>Filters</h3>
            <div class="field"><label>Job title</label><input placeholder="Director, VP"></div>
            <div class="field"><label>Industry</label><input></div>
            <div class="field"><label>Country</label><select><option>United States</option></select></div>
          </div>
          <div style="flex:2">
            <div class="row between"><div><h2>About 12,400 matches</h2><p class="caption">Preview only — emails here are not sendable.</p></div>
            <button class="btn btn-primary" data-open="modal-fetch">Get email addresses</button></div>
            <table style="margin-top:1rem"><thead><tr><th>Name</th><th>Title</th><th>Company</th><th>Location</th><th>Confidence</th></tr></thead>
            <tbody><tr><td>Jordan Lee</td><td>VP Sales</td><td>Northwind</td><td>CA, US</td><td>High</td></tr></tbody></table>
            <button class="btn btn-ghost btn-sm">Show more</button>
          </div>
        </div>
      </div>`,
  `<div id="modal-fetch" class="modal-backdrop hidden"><div class="modal"><h3>Fetch contacts?</h3><p>This spends credits and produces real email addresses.</p><div class="modal-actions"><button class="btn btn-primary" data-close="modal-fetch">Fetch</button><button class="btn btn-ghost" data-close="modal-fetch">Cancel</button></div></div></div>`);

files['buy-senders.html'] = shell('Buy senders', sideNav('Mailboxes'), `
      ${topbar('<span class="breadcrumb">Mailboxes / Buy senders</span>')}
      <div class="content">
        <div class="steps"><span class="active">1 Search domain</span><span>2 Review order</span><span>3 Done</span></div>
        <div class="split">
          <div><input placeholder="acme-outreach.com"><div class="list-card active">acme-outreach.com · Available · $12/yr</div>
          <div class="field"><label>Mailbox count</label><input value="3"></div></div>
          <div class="card"><h3>Order summary</h3><p>Domain: acme-outreach.com<br>3 × warmup-ready<br><strong>Total: $47.00</strong></p>
          <p class="caption">Harry never stores card details.</p>
          <button class="btn btn-primary" data-open="modal-order">Place order</button></div>
        </div>
      </div>`,
  `<div id="modal-order" class="modal-backdrop hidden"><div class="modal"><h3>Confirm purchase</h3><p>Buying acme-outreach.com and 3 mailboxes.</p><div class="modal-actions"><a href="order-done.html" class="btn btn-primary">Confirm</a><button class="btn btn-ghost" data-close="modal-order">Cancel</button></div></div></div>`);

files['order-done.html'] = shell('Order placed', sideNav('Mailboxes'), `
      <div class="content empty">
        <h2>Order submitted</h2>
        <p class="caption">Mailboxes appear in your fleet when provisioning finishes.</p>
        <a href="mailboxes.html" class="btn btn-primary">Back to mailboxes</a>
      </div>`);

files['settings-block-list.html'] = shell('Block list', sideNav('Settings', `
        <a href="clients-settings.html">Clients</a>
        <a href="settings-block-list.html" class="active">Block list</a>
        <a href="settings-webhooks.html">Webhooks</a>`), `
      ${topbar('')}
      <div class="content">
        <h1>Domains Harry will never email</h1>
        <p class="caption">Most entries come from unsubscribes and bounces.</p>
        <div class="row between" style="margin:1rem 0"><input placeholder="Search blocked domains" style="max-width:240px"><button class="btn btn-primary" data-open="modal-block">Add domain</button></div>
        <table><thead><tr><th>Domain</th><th>Source</th><th>Added</th></tr></thead>
        <tbody><tr><td>competitor.com</td><td><span class="badge">Manual</span></td><td>12 Apr</td></tr>
        <tr><td>bigcorp.io</td><td><span class="badge">Unsubscribed</span></td><td>3 Apr</td></tr></tbody></table>
        <p class="caption" style="margin-top:1rem">send-single-email has no UI — internal only; drafts still need approval.</p>
      </div>`,
  `<div id="modal-block" class="modal-backdrop hidden"><div class="modal"><h3>Block domain</h3><input placeholder="domain.com"><div class="modal-actions"><button class="btn btn-primary" data-close="modal-block">Block</button><button class="btn btn-ghost" data-close="modal-block">Cancel</button></div></div></div>`);

files['settings-webhooks.html'] = shell('Webhooks', sideNav('Settings', `
        <a href="settings-block-list.html">Block list</a>
        <a href="settings-webhooks.html" class="active">Webhooks</a>`), `
      ${topbar('<button class="btn btn-primary" data-open="modal-wh">Add endpoint</button>')}
      <div class="content">
        <h1>Webhooks</h1>
        <p class="caption">Tell your tools when Harry events happen.</p>
        <div class="list-card row between" style="margin-top:1rem"><div><strong>https://hooks.example.com/harry</strong><br><span class="caption">Lead replied · Lead unsubscribed · Campaign completed</span></div>
        <a href="campaign-webhooks.html" class="btn btn-ghost btn-sm">Campaign example</a></div>
      </div>`,
  `<div id="modal-wh" class="modal-backdrop hidden"><div class="modal"><h3>Add webhook</h3><input value="https://hooks.example.com/harry"><label><input type="checkbox" checked> Lead replied</label><div class="modal-actions"><button class="btn btn-primary" data-close="modal-wh">Save</button><button class="btn btn-ghost" data-close="modal-wh">Cancel</button></div></div></div>`);

files['campaign-webhooks.html'] = shell('Campaign webhooks', sideNav('Campaigns'), `
      ${topbar('<span class="breadcrumb">Q1 Cold Outreach / Settings / Webhooks</span>')}
      <div class="content">
        <p>Same pattern as workspace webhooks, scoped to this campaign.</p>
        <button class="btn btn-primary" data-open="modal-cwh">Add campaign webhook</button>
      </div>`,
  `<div id="modal-cwh" class="modal-backdrop hidden"><div class="modal"><h3>Add campaign webhook</h3><input placeholder="https://hooks.example.com/campaign"><div class="modal-actions"><button class="btn btn-primary" data-close="modal-cwh">Save</button></div></div></div>`);

for (const [name, html] of Object.entries(files)) {
  writeFileSync(join(PAGES, name), html);
}

const indexEntries = Object.keys(files).sort().map((f) => {
  const label = f.replace('.html', '').replace(/-/g, ' ');
  return `        <a href="pages/${f}"><strong>${label}</strong><small>${f}</small></a>`;
}).join('\n');

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Harry · HTML Prototype</title>
  <link rel="stylesheet" href="css/harry.css">
</head>
<body style="padding:2rem">
  <h1>Harry the Marketer — HTML Prototype</h1>
  <p class="caption">${Object.keys(files).length} pages · generated from WYRE wireforms</p>
  <div class="index-grid" style="margin-top:1.5rem">
${indexEntries}
  </div>
</body>
</html>`;

writeFileSync(join(ROOT, 'index.html'), indexHtml);
console.log('Wrote', Object.keys(files).length, 'pages + index.html');
