import { Container, Section, SectionHeading, Eyebrow, Card, CtaBand } from './ui.jsx'

const PRINCIPLES = [
  {
    title: 'Show the working',
    body:
      'If the product made a decision, you should be able to find out why in under ten seconds. The campaign is a diagram you can read. Every classification is stored with the message and can be overridden. The activity trail is complete, not curated.',
  },
  {
    title: 'Degrade honestly',
    body:
      'No AI key, no Gmail, no data provider — the product still runs, in a clearly labelled reduced mode. What it will not do is pretend. A feature that silently stops working is worse than a feature that says it is off.',
  },
  {
    title: 'Never fabricate',
    body:
      'The research agent lowers its confidence when it cannot find something rather than inventing a plausible fact. A qualification score comes with the reasons that produced it. Made-up personalisation is how outreach earns its reputation.',
  },
  {
    title: 'Respect the inbox',
    body:
      'Volume stopped being the lever in 2024. Conservative send limits, one-click unsubscribe on every message, and opt-outs honoured whether or not your diagram remembers to handle them.',
  },
  {
    title: 'Own your exit',
    body:
      'Your leads, playbooks, and copy are yours. Export them, delete them, or self-host the whole thing on a single Node process and a SQLite file. Lock-in is not a retention strategy we are interested in.',
  },
]

export default function About() {
  return (
    <>
      <Section className="border-b border-slate-200 !pb-12">
        <Container>
          <Eyebrow>About</Eyebrow>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-ink-950 leading-tight text-balance max-w-3xl">
            A quieter tool in a very loud category
          </h1>
          <p className="mt-5 text-lg text-slate-600 leading-relaxed max-w-2xl text-pretty">
            Harry The Marketer is named after the agent doing the work, not the platform selling it. That is
            roughly the whole positioning.
          </p>
        </Container>
      </Section>

      <Section>
        <Container size="narrow">
          <div className="space-y-6 text-slate-600 leading-relaxed text-lg">
            <p className="text-pretty">
              Outreach software has a shape. A sequence builder with steps in panels, an AI toggle that does
              something unspecified to your copy, a dashboard of numbers that go up, and a pricing page whose
              real cost turns out to be two to five times the headline once credits and add-ons land.
            </p>
            <p className="text-pretty">
              The frustrating part is not the price. It is that when a campaign underperforms, none of it
              tells you <em className="text-slate-700 not-italic font-medium">why</em>. Was the first email
              wrong? Was the branch after “not now” missing? Did forty leads quietly stall at a step nobody
              looked at? The tool that sent the emails is the one tool that will not say.
            </p>
            <p className="text-pretty">
              So this product starts from the opposite end. The campaign is a flowchart — one you can read,
              diff, paste into a document, and change in a second. The agent executes that flowchart against
              the live email chain and writes down every decision it makes. When something is not working,
              the report names the step.
            </p>
            <p className="text-pretty">
              It is built for founders and operators at small B2B teams who run their own outreach: technical
              enough to read a diagram, uninterested in becoming a full-time administrator of one.
            </p>
          </div>
        </Container>
      </Section>

      <Section bordered>
        <Container>
          <SectionHeading
            eyebrow="Principles"
            title="What we will not trade away"
            lede="These are the rules the product is actually built to, in the order arguments get settled."
            align="center"
          />
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {PRINCIPLES.map((p, i) => (
              <Card key={p.title} className="p-6">
                <div className="font-mono text-xs text-accent-600">{String(i + 1).padStart(2, '0')}</div>
                <h3 className="mt-3 font-semibold text-ink-950">{p.title}</h3>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed text-pretty">{p.body}</p>
              </Card>
            ))}
          </div>
        </Container>
      </Section>

      <Section bordered>
        <Container size="narrow">
          <SectionHeading
            title="What we are honest about"
            lede="A short list, because it is the part most vendors leave out."
          />
          <div className="mt-8 space-y-4 text-slate-600 leading-relaxed">
            <p className="text-pretty">
              Cold email reply rates have compressed to roughly one to three percent across the category as
              volume expanded. Any vendor quoting you a great deal more than that is quoting a best case.
              The lever that still moves is list quality and relevance, which is why qualification and
              research sit ahead of sending in this product rather than behind a higher tier.
            </p>
            <p className="text-pretty">
              Autonomous volume amplifies bad inputs. Sending six times as much from a list you have not
              qualified does not produce six times the meetings — it produces a domain reputation problem.
              The defaults here are deliberately conservative, and we would rather you turned them up
              knowingly than discovered them by accident.
            </p>
            <p className="text-pretty">
              And there are things this product does not do: no bundled prospect database, no LinkedIn
              automation, no calendar availability, no warmup pool. Those boundaries are listed on the
              product page rather than discovered after purchase.
            </p>
          </div>
        </Container>
      </Section>

      <CtaBand
        title="See whether the diagram idea holds up"
        lede="Free trial, sandbox mailbox, and a default playbook that already works."
        primary={{ to: '/signup', label: 'Start free trial' }}
        secondary={{ to: '/contact', label: 'Ask us anything' }}
      />
    </>
  )
}
