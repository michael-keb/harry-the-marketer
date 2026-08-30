import { Link } from 'react-router-dom'
import { PLANS } from '../../../shared/site-content.js'

export default function FirstRunWelcome({ planId, name }) {
  const plan = PLANS.find((p) => p.id === planId)
  const first = String(name || '').trim().split(/\s+/)[0]

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
      <h2 className="text-xl font-semibold text-ink-900">
        {first ? `${first}, your workspace is ready` : 'Your workspace is ready'}
      </h2>
      {plan?.name && (
        <p className="mt-2 text-sm text-slate-600">
          You are on a {plan.name} trial. You will not be charged today.
        </p>
      )}
      <p className="mt-3 text-slate-600 leading-relaxed">
        Nothing sends until you say so. Start with a campaign — every new one opens on a working
        playbook — or add a sandbox mailbox and run the loop without connecting Gmail.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link to="/app/campaigns?new=1" className="btn-primary">Create a campaign</Link>
        <Link to="/app/connections?area=email&add=sandbox" className="btn-ghost">Add a sandbox mailbox</Link>
      </div>
    </section>
  )
}