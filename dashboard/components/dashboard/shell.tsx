'use client'

import { useEffect, useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import useSWR from 'swr'
import { Sidebar } from './sidebar'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { fetcher } from '@/lib/fetcher'
import { CryptoLoader } from '@/components/crypto-loader'
import { Menu, LogOut, Activity, PauseCircle } from 'lucide-react'

export function Shell({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession() || {}
  const [open, setOpen] = useState(false)
  const { data: status } = useSWR('/api/bot/status', fetcher, { refreshInterval: 60000 })
  // Écran de chargement crypto au démarrage / rechargement : reste affiché tant
  // que les données clés du portefeuille ne sont pas chargées (durée mini pour l'effet).
  const { data: pf, error: pfErr } = useSWR('/api/bot/portfolio', fetcher)
  const [minElapsed, setMinElapsed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), 1700)
    return () => clearTimeout(t)
  }, [])
  const dataReady = pf !== undefined || pfErr !== undefined
  const booting = !(minElapsed && dataReady)

  const running = status?.status === 'running'

  return (
    <div className="min-h-screen bg-background">
      {booting && <CryptoLoader />}
      {/* Sidebar desktop */}
      <aside className="hidden lg:block fixed inset-y-0 left-0 w-64 z-40">
        <Sidebar />
      </aside>

      <div className="lg:pl-64 flex flex-col min-h-screen">
        {/* Header */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/60 bg-background/80 backdrop-blur-md px-4 sm:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Ouvrir le menu">
                <Menu className="h-5 w-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64 border-border/60" aria-label="Menu de navigation">
              <Sidebar onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2">
            {running ? (
              <Badge variant="outline" className="border-primary/40 text-primary gap-1.5">
                <Activity className="h-3 w-3" />
                Bot actif · {status?.mode === 'live' ? 'Live' : 'Simulation'}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-muted-foreground/40 text-muted-foreground gap-1.5">
                <PauseCircle className="h-3 w-3" />
                Statut inconnu
              </Badge>
            )}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden sm:block text-sm text-muted-foreground">
              {session?.user?.name ?? session?.user?.email ?? ''}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="gap-1.5"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              Déconnexion
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 space-y-6">{children}</main>
      </div>
    </div>
  )
}
