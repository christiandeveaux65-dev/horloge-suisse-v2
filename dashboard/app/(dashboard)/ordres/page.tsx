import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default function OrdresPage() {
  redirect('/trading?tab=ordres')
}
