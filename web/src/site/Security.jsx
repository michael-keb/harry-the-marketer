import { BRAND } from '../../../shared/site-content.js'
import { Container, Section, SectionHeading, Eyebrow, Card, Cta, CtaBand, Check } from './ui.jsx'

const SCOPES = [
  ['gmail.send', 'Send campaign and reply emails from your mailbox.'],
  ['gmail.readonly', 'Read replies so the engine can classify intent and advance the playbook.'],
  ['userinfo.email', 'Identify which mailbox you connected.'],
  ['userinfo.profile', 'Show the account name next to the mailbox.'],
]

const MEASURES = [
  ['OAuth tokens stay server-side', 'Access and refresh tokens are stored by the server and never sent to the browser or included in any API response.'],
  ['Signed, HTTP-only sessions', 'The session cookie is HMAC-signed, HTTP-only, SameSite=Lax, and marked Secure in production. It carries no personal data.'],
  ['Workspace isolation', 'Every query is scoped to a workspace id resolved from the session on each request — not from anything the client sends.'],
  ['Least-privilege scopes', 'Only the four Google scopes above are requested. There is no Drive, Calendar, or Contacts access to revoke because none is asked for.'],
  ['Security headers by default', 'Content-Security-Policy, HSTS on HTTPS, X-Frame-Options DENY, nosniff, and a strict referrer policy on every response.'],
  ['Rate limiting on the front door', 'Sign-in and public form endpoints are rate limited per IP.'],
  ['No third-party trackers', 'The marketing site and the app ship zero analytics, advertising, or session-recording scripts.'],
  ['Self-hostable', 'A single Node process and a SQLite file. If your policy says the data cannot leave your infrastructure, it does not have to.'],
]

export default function Security() {
  return (
    <>
      <Section className="border-b border-slate-200 !pb-12">
        <Container>
          <Eyebrow>Security &amp; data handling</Eyebrow>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-ink-950 leading-tight text-balance max-w-3xl">
            You are handing us your inbox. Here is exactly what happens to it.
          </h1>
          <p className="mt-5 text-lg text-slate-600 leading-relaxed max-w-2xl text-pretty">
            This page is the plain-language version. The binding documents are the{' '}
            <a href="/privacy" className="text-accent-700 hover:text-accent-600 underline underline-offset-2">Privacy Policy</a>,{' '}
            <a href="/dpa" className="text-accent-700 hover:text-accent-600 underline underline-offset-2">Data Processing Addendum</a>, and{' '}
            <a href="/sub-processors" className="text-accent-700 hover:text-accent-600 underline underline-offset-2">Sub-processors</a> list.
          </p>
        </Container>
      </Section>

      <Section>
        <Container>
          <SectionHeading
            eyebrow="Google account access"
            title="Four scopes, and no more"
            lede="Gmail scopes are classified as sensitive by Google, which means this app is subject to review and can only ask for what it demonstrably needs."
          />
          <div className="mt-10 overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Google OAuth scopes requested</caption>
              <thead className="bg-white">
                <tr className="border-b border-slate-200">
                  <th scope="col" className="px-4 py-3 font-semibold text-ink-900">Scope</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-ink-900">Why it is needed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {SCOPES.map(([scope, why]) => (
                  <tr key={scope} className="bg-white/40">
                    <td className="px-4 py-3 align-top">
                      <code className="font-mono text-[12.5px] text-accent-700 whitespace-nowrap">{scope}</code>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Card className="mt-8 p-6">
            <h3 className="font-semibold text-ink-950">Google API Services User Data Policy</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              Our use of information received from Google APIs adheres to the Google API Services User Data
              Policy, including the Limited Use requirements. Gmail data is used only to provide the features
              you enabled. It is not used for advertising, it is not sold, it is not used to train generalised
              machine-learning models, and it is not read by a human except with your explicit consent, to
              resolve a support issue you raised, for security, or where the law requires it.
            </p>
            <p className="mt-3 text-sm text-slate-600 leading-relaxed">
              You can revoke access at any time from your{' '}
              <a href="https://myaccount.google.com/permissions" rel="noopener noreferrer" target="_blank"
                className="text-accent-700 hover:text-accent-600 underline underline-offset-2">Google Account permissions</a>{' '}
              page, or by removing the mailbox in the app — which deletes its tokens immediately.
            </p>
          </Card>
        </Container>
      </Section>

      <Section bordered>
        <Container>
          <SectionHeading
            eyebrow="How the system is built"
            title="Controls that are in the code, not in a brochure"
            align="center"
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-2">
            {MEASURES.map(([title, body]) => (
              <div key={title} className="bg-white p-6">
                <div className="flex items-start gap-3">
                  <Check className="size-4 shrink-0 mt-1 text-accent-600" />
                  <div>
                    <h3 className="font-semibold text-ink-950">{title}</h3>
                    <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{body}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section bordered>
        <Container>
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
            <div>
              <Eyebrow>AI processing</Eyebrow>
              <h2 className="text-3xl font-bold tracking-tight text-ink-950 text-balance">
                What the model actually sees
              </h2>
              <p className="mt-4 text-slate-600 leading-relaxed text-pretty">
                When the agent composes an email it sends the AI provider your business context, the lead's
                fields and research profile, and the thread so far. When it classifies a reply it sends the
                reply text and your diagram's edge labels. That is the whole payload.
              </p>
              <p className="mt-4 text-slate-600 leading-relaxed text-pretty">
                Providers act as processors under their API terms and do not train their general models on
                API inputs or outputs. If your deployment has no AI key configured, nothing leaves the
                deployment at all — the agent falls back to templates and a keyword classifier.
              </p>
            </div>
            <div>
              <Eyebrow>Retention &amp; deletion</Eyebrow>
              <h2 className="text-3xl font-bold tracking-tight text-ink-950 text-balance">
                Leaving is a supported operation
              </h2>
              <ul className="mt-5 space-y-3">
                {[
                  'Disconnecting a mailbox deletes its OAuth tokens immediately.',
                  'Deleting a lead, campaign, or goal cascades to its dependent records.',
                  'Closing your account deletes workspace content within 30 days.',
                  'Operational telemetry self-prunes to the most recent records.',
                  'Self-hosted: deleting the SQLite file deletes everything.',
                ].map((item) => (
                  <li key={item} className="flex gap-3 text-sm text-slate-700">
                    <Check className="size-4 shrink-0 mt-0.5 text-accent-600" />{item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Container>
      </Section>

      <Section bordered>
        <Container size="narrow">
          <Card className="p-8 text-center">
            <h2 className="text-2xl font-bold tracking-tight text-ink-950">Reporting a vulnerability</h2>
            <p className="mt-3 text-slate-600 leading-relaxed">
              Email <a href={`mailto:${BRAND.securityEmail}`} className="text-accent-700 hover:text-accent-600">{BRAND.securityEmail}</a>{' '}
              with steps to reproduce. We will acknowledge within two business days and keep you updated until
              it is resolved. Please do not test against other people's workspaces or run automated scans
              against production — self-host an instance and test that instead.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Cta href={`mailto:${BRAND.securityEmail}`} variant="secondary">Email the security team</Cta>
              <Cta to="/contact?topic=security" variant="secondary">Request a security review</Cta>
            </div>
          </Card>
        </Container>
      </Section>

      <CtaBand
        title="Questions your security team needs answered?"
        lede="Send us the questionnaire. We would rather answer it before you sign up than after."
        primary={{ to: '/contact?topic=security', label: 'Get in touch' }}
        secondary={{ to: '/pricing', label: 'See pricing' }}
      />
    </>
  )
}
