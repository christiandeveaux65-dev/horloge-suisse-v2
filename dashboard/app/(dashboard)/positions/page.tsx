import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default function PositionsPage() {
  redirect('/trading?tab=positions')
}
