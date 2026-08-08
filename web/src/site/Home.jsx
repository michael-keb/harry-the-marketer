// The homepage does one job: show that a campaign is a diagram, and get the
// visitor to the first step. Everything it used to also carry — the problem
// statement, the feature grid, the Goals spotlight, the syntax teaser, the
// deliverability list, the pricing teaser and the FAQ — still lives on the
// pages built for it (/product, /pricing, /security), which is where someone
// who wants that depth is already heading.
import { BRAND, HERO_PLAYBOOK, HOW_IT_WORKS } from '../../../shared/site-content.js'
import PlaybookDiagram from './PlaybookDiagram.jsx'
import { Container, Section, SectionHeading, Cta, Card, CtaBand } from './ui.jsx'

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Faint flowchart grid — the product's own visual language, not decoration. */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          backgroundImage:
            'linear-gradient(to right, #e6f6f0 1px, transparent 1px), linear-gradient(to bottom, #e6f6f0 1px, transparent 1px)',
          backgroundSize: '3rem 3rem',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)',
        }}
      />
      <Container className="relative">
        <div className="py-16 sm:py-24 grid gap-12 lg:grid-cols-[1fr_1.05fr] lg:items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-accent-200 bg-accent-50 px-3 py-1 text-xs font-medium text-accent-700">
              <span className="size-1.5 rounded-full bg-accent-500" aria-hidden />
              Runs on your own Gmail — or a sandbox mailbox
            </div>

            <h1 className="mt-5 text-4xl sm:text-5xl lg:text-[3.4rem] font-bold tracking-tight text-ink-950 leading-[1.08] text-balance">
              Outreach campaigns
              <br className="hidden sm:block" /> you can <span className="text-accent-600">draw</span>.
            </h1>

            <p className="mt-6 text-lg text-slate-600 leading-relaxed max-w-lg text-pretty">
              Draw the campaign as a flowchart. An AI agent runs it per lead — writing each email,
              reading the reply, and taking the branch that reply earned.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Cta to="/signup" size="large">Start free trial</Cta>
              <Cta to="/product" variant="secondary" size="large">See how it works</Cta>
            </div>

            <p className="mt-4 text-xs text-slate-500">Free trial, no card.</p>
          </div>

          <div>
            <Card className="overflow-hidden shadow-xl shadow-slate-900/5">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
                <span className="font-mono text-xs text-slate-500">playbook.mmd</span>
                <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-medium text-accent-700">
                  valid · running
                </span>
              </div>
              <PlaybookDiagram code={HERO_PLAYBOOK} label="Example campaign playbook" />
              <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
                This diagram <span className="text-ink-900 font-medium">is</span> the campaign. Change an
                edge, save, and the engine routes differently on the next tick.
              </div>
            </Card>
          </div>
        </div>
      </Container>
    </section>
  )
}

// The one inverted block on the page. The ink surface is where diagrams and
// source live in this product, so the "how it runs" step is the piece that
// keeps it rather than the whole site.
function HowItWorks() {
  return (
    <Section tone="dark" id="how">
      <Container>
        <SectionHeading
          tone="dark"
          eyebrow="How it works"
          title="Three steps, then it runs without you"
          align="center"
        />
        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {HOW_IT_WORKS.map((step) => (
            <Card key={step.step} tone="dark" className="p-6">
              <div className="font-mono text-xs text-accent-400">{step.step}</div>
              <h3 className="mt-3 text-lg font-semibold text-white">{step.title}</h3>
              <p className="mt-2.5 text-sm text-slate-400 leading-relaxed text-pretty">{step.body}</p>
            </Card>
          ))}
        </div>
        <div className="mt-12 text-center">
          <Cta to="/product" variant="onDark">Read the full walkthrough</Cta>
        </div>
      </Container>
    </Section>
  )
}

export default function Home() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <CtaBand
        title="Draw your first campaign today"
        lede={`${BRAND.promise} Run the whole loop in a sandbox mailbox before a single real email goes out.`}
        primary={{ to: '/signup', label: 'Start free trial' }}
        secondary={{ to: '/contact', label: 'Talk to us' }}
      />
    </>
  )
}
