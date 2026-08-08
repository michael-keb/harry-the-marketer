// Registry for the SmartLead-parity modules.
//
// Each module exports `register(api)` and owns exactly one category from
// Docs/README.md. They are mounted onto the same router as the original routes,
// behind the same requireUser + workspace middleware, so every handler already
// has req.user and req.wsId. Order matters only where a literal path could be
// shadowed by a parameterised one — the literal-first modules come first.

import { register as registerTags } from './tags.js'
import { register as registerNotes } from './notes.js'
import { register as registerLists } from './lists.js'
import { register as registerClients } from './clients.js'
import { register as registerWebhooks } from './webhooks.js'
import { register as registerInbox } from './inbox.js'
import { register as registerAnalytics } from './analytics.js'
import { register as registerCampaigns } from './campaigns.js'
import { register as registerLeads } from './leads.js'
import { register as registerMailboxes } from './mailboxes.js'
import { register as registerDeliverability } from './deliverability.js'
import { register as registerProspects } from './prospects.js'
import { register as registerSenders } from './senders.js'
import { register as registerUtilities } from './utilities.js'
import { register as registerGaps } from './gaps.js'
import { providerStatus } from './providers.js'

export function registerParity(api) {
  // Literal prefixes first: /api/leads/activities must not be captured by
  // /api/leads/:id, and /api/campaigns/statistics likewise.
  registerUtilities(api)
  registerGaps(api)
  registerTags(api)
  registerNotes(api)
  registerLists(api)
  registerClients(api)
  registerWebhooks(api)
  registerInbox(api)
  registerAnalytics(api)
  registerDeliverability(api)
  registerProspects(api)
  registerSenders(api)
  registerMailboxes(api)
  registerLeads(api)
  registerCampaigns(api)

  // Which optional providers are wired up. The UI reads this to decide whether
  // to show live data or an honest "not connected" state.
  api.get('/integrations/status', (req, res) => res.json(providerStatus()))
}
