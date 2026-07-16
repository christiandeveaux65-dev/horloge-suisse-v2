import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default function JournalPage() {
  redirect('/strategies?tab=journal')
}
