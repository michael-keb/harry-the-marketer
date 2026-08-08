import { Fragment, useState } from 'react'
import { PLANS, PLAN_COMPARISON, ANNUAL_DISCOUNT_NOTE, FAQS } from '../../../shared/site-content.js'
import { Container, Section, SectionHeading, Eyebrow, Card, Cta, Check, Dash, Faq, CtaBand, FeatureList } from './ui.jsx'

function BillingToggle({ annual, onChange }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1" role="group" aria-label="Billing period">
      {[
        { key: false, label: 'Monthly' },
        { key: true, label: 'Annual' },
      ].map((opt) => (
        <button
          key={String(opt.key)}
          type="button"
          aria-pressed={annual === opt.key}
          onClick={() => onChange(opt.key)}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
            annual === opt.key ? 'bg-accent-500 text-ink-950' : 'text-slate-600 hover:text-ink-900'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function PriceLabel({ plan, annual }) {
  if (plan.monthly === null) {
    return <div className="text-3xl font-bold text-ink-950">Custom</div>
  }
  const price = annual ? plan.annual : plan.monthly
  return (
    <div>
      <div className="flex items-baseline gap-1">
        <span className="text-4xl font-bold text-ink-950">${price}</span>
        <span className="text-sm text-slate-500">/month</span>
      </div>
      <p className="mt-1 text-xs text-slate-500 h-4">
        {annual ? `billed yearly — ${ANNUAL_DISCOUNT_NOTE}` : 'billed monthly'}
      </p>
    </div>
  )
}

// Icons alone leave a screen reader with an empty cell, so each carries its own
// visually hidden label.
function ComparisonCell({ value }) {
  if (value === true) {
    return (
      <span className="flex justify-center text-accent-600">
        <Check className="size-4" />
        <span className="sr-only">Included</span>
      </span>
    )
  }
  if (value === false || value === undefined) {
    return (
      <span className="flex justify-center text-slate-600">
        <Dash className="size-4" />
        <span className="sr-only">Not included</span>
      </span>
    )
  }
  return <span className="text-sm text-slate-700">{value}</span>
}

export default function Pricing() {
  const [annual, setAnnual] = useState(true)

  return (
    <>
      <Section className="border-b border-slate-200">
        <Container>
          <div className="text-center max-w-2xl mx-auto">
            <Eyebrow>Pricing</Eyebrow>
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-ink-950 text-balance">
              Priced per workspace, not per seat you regret
            </h1>
            <p className="mt-5 text-lg text-slate-600 leading-relaxed text-pretty">
              Start with a free trial and run a complete campaign end to end before you pay. Every plan
              includes unsubscribe handling, send limits, and delivery telemetry.
            </p>
            <div className="mt-8 flex justify-center">
              <BillingToggle annual={annual} onChange={setAnnual} />
            </div>
          </div>

          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {PLANS.map((plan) => (
              <Card
                key={plan.id}
                className={`relative flex flex-col p-6 ${plan.featured ? 'border-accent-600 ring-1 ring-accent-600/30' : ''}`}
              >
                {plan.badge && (
                  <span className="absolute -top-3 left-6 rounded-full bg-accent-500 px-2.5 py-0.5 text-[11px] font-semibold text-ink-950">
                    {plan.badge}
                  </span>
                )}
                <h2 className="font-semibold text-ink-950">{plan.name}</h2>
                <div className="mt-4">
                  <PriceLabel plan={plan} annual={annual} />
                </div>
                <p className="mt-4 text-sm text-slate-600 leading-relaxed min-h-[3.5rem]">{plan.tagline}</p>
                <Cta to={plan.ctaTo} variant={plan.featured ? 'primary' : 'secondary'} className="w-full">
                  {plan.cta}
                </Cta>
                <FeatureList items={plan.features} className="mt-6 pt-6 border-t border-slate-200" />
              </Card>
            ))}
          </div>

          <p className="mt-8 text-center text-xs text-slate-500">
            Prices in USD, excluding tax. Annual plans are billed for the full term — {ANNUAL_DISCOUNT_NOTE}.
          </p>
        </Container>
      </Section>

      <Section>
        <Container>
          <SectionHeading
            eyebrow="Compare"
            title="Everything, side by side"
            lede="No asterisks and no metered credits — the limits below are the limits."
            align="center"
          />

          <div className="mt-12 overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[46rem] text-left">
              <caption className="sr-only">Feature comparison across plans</caption>
              <thead className="sticky top-16 bg-white">
                <tr className="border-b border-slate-200">
                  <th scope="col" className="px-4 py-4 text-sm font-semibold text-ink-900 w-[34%]">Feature</th>
                  {PLANS.map((p) => (
                    <th key={p.id} scope="col" className="px-4 py-4 text-center text-sm font-semibold text-ink-900">
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PLAN_COMPARISON.map((group) => (
                  <Fragment key={group.group}>
                    <tr className="bg-white/60">
                      <th scope="colgroup" colSpan={PLANS.length + 1}
                        className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-600">
                        {group.group}
                      </th>
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={`${group.group}-${row.label}`} className="border-t border-slate-200">
                        <th scope="row" className="px-4 py-3 text-sm font-normal text-slate-700">{row.label}</th>
                        {PLANS.map((p) => (
                          <td key={p.id} className="px-4 py-3 text-center">
                            <ComparisonCell value={row.values[p.id]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Container>
      </Section>

      <Section bordered>
        <Container>
          <div className="grid gap-6 md:grid-cols-3">
            {[
              ['What counts as a mailbox?', 'Any sending account connected to your workspace — a connected Gmail account or a sandbox mailbox. Sandbox mailboxes count towards the limit so the number means the same thing on every plan.'],
              ['What happens at the lead limit?', 'You keep sending to the leads you have; new imports are blocked until you upgrade or remove some. Campaigns never stop mid-flight because of a plan limit.'],
              ['Can I change plans?', 'Any time. Upgrades are prorated immediately; downgrades take effect at the end of the current period, and we tell you first if the new limits would affect existing data.'],
            ].map(([q, a]) => (
              <div key={q}>
                <h3 className="font-semibold text-ink-950">{q}</h3>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">{a}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section bordered>
        <Container size="narrow">
          <SectionHeading title="Still deciding?" align="center" className="mb-12" />
          <Faq items={FAQS} />
        </Container>
      </Section>

      <CtaBand
        title="Try it before you pay for it"
        lede="Run the whole loop on a sandbox mailbox during your trial — enough to decide with evidence, not a demo."
        primary={{ to: '/signup', label: 'Start free trial' }}
        secondary={{ to: '/contact', label: 'Talk to sales' }}
      />
    </>
  )
}
