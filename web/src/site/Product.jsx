import { HERO_PLAYBOOK, PLAYBOOK_SYNTAX } from '../../../shared/site-content.js'
import PlaybookDiagram from './PlaybookDiagram.jsx'
import { Container, Section, SectionHeading, Eyebrow, Card, Cta, CtaBand, CodeBlock, Check } from './ui.jsx'

function PageHero() {
  return (
    <Section className="border-b border-slate-200 !pb-12">
      <Container>
        <Eyebrow>How it works</Eyebrow>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-ink-950 leading-tight text-balance max-w-3xl">
          The playbook is the program. The engine just runs it.
        </h1>
        <p className="mt-5 text-lg text-slate-600 leading-relaxed max-w-2xl text-pretty">
          Nothing here is hidden behind a wizard. This page walks the whole path — the diagram you write,
          the tick loop that executes it, what happens to a reply, and the reports that tell you which
          step earned it.
        </p>
      </Container>
    </Section>
  )
}

function Playbooks() {
  return (
    <Section id="playbooks">
      <Container>
        <SectionHeading
          eyebrow="Step one"
          title="Write the campaign as a diagram"
          lede="Standard Mermaid flowchart syntax with a handful of conventions the engine understands. It renders live as you type and is validated on the server before a campaign can launch."
        />
        <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-start">
          <Card className="overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-2.5 text-xs font-mono text-slate-500">playbook.mmd</div>
            <PlaybookDiagram code={HERO_PLAYBOOK} label="Campaign playbook" />
          </Card>

          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <caption className="sr-only">Playbook syntax reference</caption>
              <thead>
                <tr className="border-b border-slate-200 bg-white">
                  <th scope="col" className="px-4 py-3 text-left font-semibold text-ink-900">Element</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold text-ink-900">Meaning</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {PLAYBOOK_SYNTAX.map((row) => (
                  <tr key={row.token} className="bg-white/40">
                    <td className="px-4 py-3 align-top">
                      <code className="font-mono text-[12.5px] text-accent-700 whitespace-nowrap">{row.token}</code>
                    </td>
                    <td className="px-4 py-3 align-top text-slate-600">{row.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-6 text-sm text-slate-500 max-w-3xl">
          Intents are free-form. The classifier picks the best match from your own edge labels plus the
          built-ins — <span className="font-mono text-slate-600">interested</span>,{' '}
          <span className="font-mono text-slate-600">not interested</span>,{' '}
          <span className="font-mono text-slate-600">not now</span>,{' '}
          <span className="font-mono text-slate-600">question</span>,{' '}
          <span className="font-mono text-slate-600">unsubscribe</span>,{' '}
          <span className="font-mono text-slate-600">out of office</span>.
        </p>
      </Container>
    </Section>
  )
}

function Mailboxes() {
  return (
    <Section bordered id="mailboxes">
      <Container>
        <SectionHeading
          eyebrow="Step two"
          title="Connect a mailbox — or don't, yet"
          lede="Every email is sent through your own account, in its own thread, so replies land in your normal inbox and the conversation looks like a conversation."
        />
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <Card className="p-6">
            <h3 className="font-semibold text-ink-950">Gmail, via OAuth</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              Connect with Google and the agent sends through the Gmail API from your address. It requests
              only <code className="font-mono text-accent-700 text-xs">gmail.send</code> and{' '}
              <code className="font-mono text-accent-700 text-xs">gmail.readonly</code> — enough to send and
              to pull the replies it needs to route. Tokens are stored server-side and never reach the browser.
            </p>
            <ul className="mt-5 space-y-2.5">
              {['Sends in real Gmail threads', 'Replies sync back automatically', 'Revoke access any time from your Google account'].map((i) => (
                <li key={i} className="flex gap-2.5 text-sm text-slate-700">
                  <Check className="size-4 shrink-0 mt-0.5 text-accent-600" />{i}
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-6">
            <h3 className="font-semibold text-ink-950">Sandbox mailbox</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              A mailbox that records sends locally and lets you type the reply yourself. The engine cannot
              tell the difference — branching, timeouts, classification, and outcomes all behave exactly as
              they will in production.
            </p>
            <ul className="mt-5 space-y-2.5">
              {['No credentials, no risk to a domain', 'Simulate any reply to test a branch', 'The fastest way to trust the thing before it sends'].map((i) => (
                <li key={i} className="flex gap-2.5 text-sm text-slate-700">
                  <Check className="size-4 shrink-0 mt-0.5 text-accent-600" />{i}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </Container>
    </Section>
  )
}

function Engine() {
  return (
    <Section bordered id="engine">
      <Container>
        <SectionHeading
          eyebrow="Step three"
          title="The tick loop"
          lede="Every 20 seconds — and on demand — the engine walks each lead's position in the graph and does the next thing the diagram says to do."
        />
        <div className="mt-12 grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:items-start">
          <ol className="relative space-y-6 border-l border-slate-200 pl-8">
            {[
              ['Send', 'At a Send: node, the agent composes the email from your instruction, your business context, the lead record, its research profile, and the thread so far — then sends and records the node that produced it.'],
              ['Wait', 'At a branch point the lead sits until either a reply arrives or a no-reply timeout expires. Wait: nodes pause for a fixed duration.'],
              ['Pull', 'New replies are pulled from the connected mailbox and matched back to the lead and thread.'],
              ['Classify', 'The reply is classified against your diagram\'s own edge labels. The intent is stored on the message so you can see, and change, what it decided.'],
              ['Branch', 'The lead follows the matching edge. No match means it is flagged for a human — it is never silently dropped, and unsubscribe is honoured whether or not you drew that edge.'],
              ['Finish', 'A terminal node closes the lead with an outcome: Won, Lost, or Unsubscribed. Reports and goal progress are measured from these, not from emails sent.'],
            ].map(([title, body], i) => (
              <li key={title} className="relative">
                <span className="absolute -left-[41px] flex size-5 items-center justify-center rounded-full border border-accent-600 bg-slate-50 text-[10px] font-mono text-accent-700">
                  {i + 1}
                </span>
                <h3 className="font-semibold text-ink-950">{title}</h3>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed text-pretty">{body}</p>
              </li>
            ))}
          </ol>

          <div className="space-y-6">
            <CodeBlock label="What the agent logs">
{`14:22:04  sent      A → alex@northwind.io
14:22:04  tracked   open pixel + 2 signed links
14:41:19  reply     "who handles this at your end?"
14:41:20  classify  question (0.86)
14:41:20  branch    A -- reply: question --> Q
14:41:22  sent      Q → alex@northwind.io
18:41:20  timeout   no reply 3d armed for lead 812`}
            </CodeBlock>
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-ink-950">Without an AI key</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                Composition falls back to deterministic templates with merge fields and classification to a
                keyword matcher. Everything else is identical, and the dashboard states which mode is live.
                Nothing silently degrades.
              </p>
            </Card>
          </div>
        </div>
      </Container>
    </Section>
  )
}

function InboxSection() {
  return (
    <Section bordered id="inbox">
      <Container>
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <Eyebrow>When a human is needed</Eyebrow>
            <h2 className="text-3xl font-bold tracking-tight text-ink-950 text-balance">
              An inbox that already knows what each reply meant
            </h2>
            <p className="mt-4 text-slate-600 leading-relaxed text-pretty">
              Every reply across every campaign, tagged with its classified intent. Open the thread, reply by
              hand, or reclassify it and let the engine re-route the lead down the correct branch.
            </p>
            <p className="mt-4 text-slate-600 leading-relaxed text-pretty">
              Anything the agent could not route lands in the Action Center on the dashboard, with the full
              thread and a one-click resume. The parked pile is always visible and always countable — the
              opposite of leads quietly rotting in a sequence.
            </p>
          </div>
          <div className="space-y-3">
            {[
              // Full class strings, not interpolated — Tailwind only sees literals.
              ['interested', 'Happy to chat — Tuesday afternoon works.', 'bg-emerald-50/40 text-emerald-700'],
              ['question', 'Who handles this at your end, and what does onboarding look like?', 'bg-sky-50 text-sky-700'],
              ['not now', 'Revisit us after the new fiscal year starts.', 'bg-amber-50 text-amber-800'],
              ['unsubscribe', 'Please remove me from this list.', 'bg-red-50 text-red-700'],
            ].map(([intent, text, tone]) => (
              <div key={intent} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white/60 p-4">
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
                  {intent}
                </span>
                <p className="text-sm text-slate-700 leading-relaxed">{text}</p>
              </div>
            ))}
            <p className="text-xs text-slate-500 pt-1">
              Intent chips are generated from your own edge labels — these are just the common ones.
            </p>
          </div>
        </div>
      </Container>
    </Section>
  )
}

function Reports() {
  return (
    <Section bordered id="reports">
      <Container>
        <SectionHeading
          eyebrow="Learning"
          title="Reports that name the step, not just the rate"
          lede="A funnel is only useful if it tells you what to change. Every reply is attributed back to the playbook step that earned it, so the report can say which steps to lean into and which to rewrite."
        />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Pipeline funnel', 'Stage-by-stage conversion across every campaign, with drop-off called out.'],
            ['Per-campaign rates', 'Reply, interested, win, and unsubscribe rates, plus reply-intent breakdown.'],
            ['Node performance', 'Emails sent and leads currently sitting at each node in the diagram.'],
            ['Live monitoring', 'Component health, engine tick durations, AI latency and failures, delivery telemetry per mailbox, and an incident feed.'],
          ].map(([title, body]) => (
            <Card key={title} className="p-5">
              <h3 className="text-sm font-semibold text-ink-950">{title}</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">{body}</p>
            </Card>
          ))}
        </div>
      </Container>
    </Section>
  )
}

function Honesty() {
  return (
    <Section bordered>
      <Container size="narrow">
        <SectionHeading
          eyebrow="What it does not do"
          title="The honest boundary"
          lede="A list of what this platform is not, so you can decide with the facts rather than after the invoice."
        />
        <div className="mt-10 space-y-4">
          {[
            ['No built-in lead database', 'There is no bundled prospect database. Import your own leads by CSV with column mapping and dedupe, or bring a data provider.'],
            ['No LinkedIn automation', 'Deliberate. Automating LinkedIn risks the account; a playbook step can instruct a human to do it instead.'],
            ['No calendar availability', 'You set a scheduler link and the agent includes it when it proposes a call. Real availability and rescheduling would need a calendar integration.'],
            ['No warmup pool', 'Conservative daily limits and delivery telemetry are here; a shared warmup network is external infrastructure.'],
          ].map(([title, body]) => (
            <div key={title} className="flex gap-4 rounded-xl border border-slate-200 p-5">
              <span className="mt-1 shrink-0 text-slate-600" aria-hidden>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4">
                  <path d="M6 12h12" />
                </svg>
              </span>
              <div>
                <h3 className="font-semibold text-ink-950">{title}</h3>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">{body}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-8">
          <Cta to="/contact" variant="secondary">Ask us about an integration</Cta>
        </div>
      </Container>
    </Section>
  )
}

export default function Product() {
  return (
    <>
      <PageHero />
      <Playbooks />
      <Mailboxes />
      <Engine />
      <InboxSection />
      <Reports />
      <Honesty />
      <CtaBand
        title="Run one campaign and judge it on the trail it leaves"
        lede="Sandbox mailbox, a default playbook that already works, and every decision the agent makes written down."
        primary={{ to: '/signup', label: 'Start free trial' }}
        secondary={{ to: '/pricing', label: 'See pricing' }}
      />
    </>
  )
}
