'use client'

import { useEffect, useState } from 'react'
import { signIn, useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PinInput } from '@/components/pin-input'
import { CryptoLoader } from '@/components/crypto-loader'
import { ShieldCheck, KeyRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

type Step = 'enter' | 'create' | 'confirm'

export function LoginClient() {
  const router = useRouter()
  const { status } = useSession() || {}
  const { data: pinStatus, isLoading: loadingStatus } = useSWR<{ configured: boolean }>(
    '/api/auth/pin-status',
    fetcher,
  )

  const [step, setStep] = useState<Step>('enter')
  const [pin, setPin] = useState('')
  const [firstPin, setFirstPin] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Détermine l'étape initiale selon qu'un PIN existe ou non
  useEffect(() => {
    if (!pinStatus) return
    setStep(pinStatus.configured ? 'enter' : 'create')
  }, [pinStatus])

  useEffect(() => {
    if (status === 'authenticated') router.replace('/')
  }, [status, router])

  const doSignIn = async (code: string) => {
    setSubmitting(true)
    const res = await signIn('credentials', { pin: code, redirect: false })
    if (res?.ok) {
      toast.success('Connexion réussie')
      router.replace('/')
      // On garde l'écran de chargement affiché pendant la redirection
    } else {
      setSubmitting(false)
      setPin('')
      toast.error('Code PIN incorrect')
    }
  }

  // Étape 1 (création) : mémoriser le premier PIN puis demander confirmation
  const handleCreateComplete = (code: string) => {
    setFirstPin(code)
    setPin('')
    setStep('confirm')
  }

  // Étape 2 (confirmation) : vérifier la correspondance puis créer + connecter
  const handleConfirmComplete = async (code: string) => {
    if (code !== firstPin) {
      toast.error('Les deux codes ne correspondent pas')
      setPin('')
      setFirstPin('')
      setStep('create')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/pin-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? 'Impossible de créer le code PIN')
        setSubmitting(false)
        setPin('')
        return
      }
      await doSignIn(code)
    } catch {
      setSubmitting(false)
      toast.error('Erreur réseau')
    }
  }

  // Écran de chargement pendant la connexion / redirection
  if (submitting || status === 'authenticated') {
    return <CryptoLoader message="Connexion sécurisée à la blockchain…" />
  }

  const isCreate = step === 'create' || step === 'confirm'

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background p-4 overflow-hidden">
      {/* Halo décoratif */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 0%, rgba(45,212,167,0.10), transparent 45%), radial-gradient(circle at 50% 100%, rgba(56,189,248,0.08), transparent 45%)',
        }}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-primary/10 border border-primary/30 glow-green">
            <KeyRound className="h-7 w-7 text-primary" aria-hidden="true" />
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight">PnL Maker</h1>
          <p className="text-muted-foreground text-sm">Dashboard du bot de trading DCA + Momentum</p>
        </div>

        <Card className="glow-card border-border/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
              {isCreate ? 'Création du code PIN' : 'Accès au dashboard'}
            </CardTitle>
            <CardDescription>
              {loadingStatus
                ? 'Vérification…'
                : step === 'create'
                  ? 'Choisissez un code à 6 chiffres pour protéger votre dashboard.'
                  : step === 'confirm'
                    ? 'Saisissez à nouveau votre code pour le confirmer.'
                    : 'Saisissez votre code PIN à 6 chiffres pour vous connecter.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingStatus ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
              </div>
            ) : step === 'enter' ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (pin.length === 6) doSignIn(pin)
                }}
                className="space-y-6"
                aria-label="Formulaire de connexion par code PIN"
              >
                <PinInput value={pin} onChange={setPin} autoFocus onComplete={(c) => doSignIn(c)} />
                <Button type="submit" className="w-full" disabled={pin.length !== 6}>
                  Se connecter
                </Button>
              </form>
            ) : step === 'create' ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (pin.length === 6) handleCreateComplete(pin)
                }}
                className="space-y-6"
                aria-label="Formulaire de création du code PIN"
              >
                <PinInput value={pin} onChange={setPin} autoFocus onComplete={handleCreateComplete} />
                <Button type="submit" className="w-full" disabled={pin.length !== 6}>
                  Continuer
                </Button>
              </form>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (pin.length === 6) handleConfirmComplete(pin)
                }}
                className="space-y-6"
                aria-label="Formulaire de confirmation du code PIN"
              >
                <PinInput value={pin} onChange={setPin} autoFocus onComplete={handleConfirmComplete} />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setPin('')
                      setFirstPin('')
                      setStep('create')
                    }}
                  >
                    Recommencer
                  </Button>
                  <Button type="submit" className="flex-1" disabled={pin.length !== 6}>
                    Confirmer
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">
          Accès protégé par un code PIN unique à 6 chiffres.
        </p>
      </div>
    </div>
  )
}
