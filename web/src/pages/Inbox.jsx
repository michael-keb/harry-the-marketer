// Inbox — both halves of the conversation in one place: emails waiting for your
// OK before they go out, and every reply that has come back.
//
// Approvals live here rather than behind their own nav item on purpose. Reading
// what the agent wrote and reading what a lead said are the same daily habit,
// and the queue you must clear is the first folder the rail offers.
//
// The page itself is only a frame. Everything below the title is the mail
// client in web/src/inbox/MailClient.jsx: folders on the left, a dense list in
// the middle, the whole conversation on the right.
//
// The one thing this file is really deciding is height. The app's page column
// is a scrolling container with 2rem above and 6rem below; a mail client cannot
// live in that, because its three panes each have to scroll on their own. So
// above 1024px the frame claims the viewport minus those gutters and the panes
// scroll inside it. Below that it grows with its content, like every other page.

import { PageHeader } from '../ui.jsx'
import MailClient from '../inbox/MailClient.jsx'

export default function Inbox() {
  return (
    // 8rem is the page column's own pt-8 + pb-24. The mobile top bar adds
    // another 3.5rem, but it is gone by 768px and the three-pane frame only
    // exists from 1024px, so it never applies here.
    <div className="flex min-h-[34rem] flex-col lg:h-[calc(100dvh-8rem)] lg:min-h-0">
      <PageHeader title="Inbox" lead="The agent drafts. Nothing sends until you say so." />
      <MailClient />
    </div>
  )
}
