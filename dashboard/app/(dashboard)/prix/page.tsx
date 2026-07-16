import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default function PrixPage() {
  redirect('/strategies?tab=prix')
}
