import { useState } from 'react'
import GoogleIcon from './GoogleIcon.jsx'

export default function GoogleContinue({ href, label }) {
  const [leaving, setLeaving] = useState(false)

  return (
    <a
      href={href}
      className="btn-primary w-full justify-center text-base py-2.5"
      aria-busy={leaving}
      aria-disabled={leaving}
      onClick={(e) => {
        if (leaving) e.preventDefault()
        else setLeaving(true)
      }}
    >
      {leaving ? 'Redirecting to Google…' : <><GoogleIcon />{label}</>}
    </a>
  )
}