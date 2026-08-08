import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { BRAND } from '../../../shared/site-content.js'
import { Container, Section, Eyebrow, Card, Cta, Check } from './ui.jsx'

const TOPICS = [
  { value: 'general', label: 'General question' },
  { value: 'sales', label: 'Choosing a plan' },
  { value: 'scale', label: 'Scale plan / procurement' },
  { value: 'security', label: 'Security review' },
  { value: 'support', label: 'Support' },
  { value: 'privacy', label: 'Privacy / data request' },
]

export default function Contact() {
  const [params] = useSearchParams()
  const initialTopic = TOPICS.some((t) => t.value === params.get('topic')) ? params.get('topic') : 'general'

  const [form, setForm] = useState({
    name: '', email: '', company: '', topic: initialTopic, message: '', company_website: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.post('/api/public/contact', form)
      setSent(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section>
      <Container>
        <div className="grid gap-12 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
          <div>
            <Eyebrow>Contact</Eyebrow>
            <h1 className="text-4xl font-bold tracking-tight text-ink-950 leading-tight text-balance">
              Talk to the people who built it
            </h1>
            <p className="mt-5 text-slate-600 leading-relaxed text-pretty">
              There is no qualification gauntlet and no discovery call before you can ask a question. Tell us
              what you are trying to do and we will tell you honestly whether this fits.
            </p>

            <div className="mt-10 space-y-5">
              {[
                ['General and sales', BRAND.supportEmail],
                ['Security and vulnerability reports', BRAND.securityEmail],
                ['Privacy and data requests', BRAND.privacyEmail],
              ].map(([label, email]) => (
                <div key={email}>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</div>
                  <a href={`mailto:${email}`} className="text-accent-700 hover:text-accent-600">{email}</a>
                </div>
              ))}
            </div>

            <Card className="mt-10 p-5">
              <h2 className="text-sm font-semibold text-ink-950">Already using it?</h2>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                Support questions move faster from inside your workspace — the Monitoring page usually
                answers “why has nothing sent?” before we can.
              </p>
              <Cta to="/login" variant="secondary" size="small" className="mt-4">Sign in</Cta>
            </Card>
          </div>

          <Card className="p-6 sm:p-8">
            {sent ? (
              <div className="py-10 text-center">
                <div className="mx-auto flex size-11 items-center justify-center rounded-full border border-accent-600 text-accent-600">
                  <Check className="size-5" />
                </div>
                <h2 className="mt-4 text-xl font-semibold text-ink-950">Message received</h2>
                <p className="mt-2 text-sm text-slate-600 max-w-sm mx-auto leading-relaxed">
                  We reply to everything, usually within one business day. If it is urgent, email{' '}
                  <a href={`mailto:${BRAND.supportEmail}`} className="text-accent-700 hover:text-accent-600">
                    {BRAND.supportEmail}
                  </a>{' '}
                  directly.
                </p>
                <Cta to="/" variant="secondary" className="mt-6">Back to the homepage</Cta>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-5" noValidate>
                <h2 className="text-lg font-semibold text-ink-950">Send us a message</h2>

                {error && (
                  <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1.5" htmlFor="contact-name">
                      Name <span className="text-red-400" aria-hidden>*</span>
                    </label>
                    <input id="contact-name" className="input-site" required autoComplete="name"
                      value={form.name} onChange={set('name')} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1.5" htmlFor="contact-email">
                      Work email <span className="text-red-400" aria-hidden>*</span>
                    </label>
                    <input id="contact-email" className="input-site" type="email" required autoComplete="email"
                      placeholder="you@company.com" value={form.email} onChange={set('email')} />
                  </div>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1.5" htmlFor="contact-company">Company</label>
                    <input id="contact-company" className="input-site" autoComplete="organization"
                      value={form.company} onChange={set('company')} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1.5" htmlFor="contact-topic">What is it about?</label>
                    <select id="contact-topic" className="input-site" value={form.topic} onChange={set('topic')}>
                      {TOPICS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-600 mb-1.5" htmlFor="contact-message">
                    Message <span className="text-red-400" aria-hidden>*</span>
                  </label>
                  <textarea id="contact-message" className="input-site min-h-36 resize-y" required
                    placeholder="What are you trying to do, and what is in the way?"
                    value={form.message} onChange={set('message')} />
                </div>

                {/* Honeypot — hidden from people, irresistible to bots. */}
                <div className="absolute left-[-9999px]" aria-hidden>
                  <label htmlFor="contact-website">Do not fill this in</label>
                  <input id="contact-website" tabIndex={-1} autoComplete="off"
                    value={form.company_website} onChange={set('company_website')} />
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent-500 px-5 py-3 text-base font-semibold text-ink-950 transition-colors hover:bg-accent-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400"
                  >
                    {busy ? 'Sending…' : 'Send message'}
                  </button>
                  <p className="text-xs text-slate-500 max-w-xs">
                    We use this only to reply. See the{' '}
                    <a href="/privacy" className="text-slate-600 hover:text-accent-700 underline underline-offset-2">
                      Privacy Policy
                    </a>.
                  </p>
                </div>
              </form>
            )}
          </Card>
        </div>
      </Container>
    </Section>
  )
}
