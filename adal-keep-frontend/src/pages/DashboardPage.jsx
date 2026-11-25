import MorningSignIn from '../components/MorningSignIn'
import MorningHeader from '../components/MorningHeader'
import { onPhone } from '../lib/phoneMode'
import { useAuth } from '../context/AuthContext'
import { lastPlace } from '../lib/lastPlace'
import { BackupLine, DaySummaryCard } from '../components/OfficeCards'

// The page everyone lands on (written in Amharic; English from lib/i18n.js).
// Calm: the greeting with one Tasks button and "Continue where you left off",
// then the morning sign-in. No counts, and nothing asked of the PC for them.
export default function DashboardPage() {
  const { company, activeEmployee } = useAuth()
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <MorningHeader name={activeEmployee?.name || ''} company={company} place={lastPlace()} />
      {!onPhone() && <MorningSignIn />}
      {!onPhone() && <BackupLine />}
      <DaySummaryCard />
    </div>
  )
}
