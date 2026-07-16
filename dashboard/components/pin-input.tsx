'use client'

import { useRef } from 'react'

/**
 * Saisie d'un code PIN à 6 chiffres avec 6 cases, auto-avancement,
 * retour arrière et collage supportés.
 */
export function PinInput({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  ariaLabel = 'Code PIN à 6 chiffres',
  onComplete,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  autoFocus?: boolean
  ariaLabel?: string
  onComplete?: (v: string) => void
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const digits = value.padEnd(6, ' ').slice(0, 6).split('')

  const setDigit = (i: number, d: string) => {
    const arr = value.padEnd(6, ' ').slice(0, 6).split('')
    arr[i] = d
    const next = arr.join('').replace(/\s/g, '')
    onChange(next)
    if (next.length === 6 && onComplete) onComplete(next)
  }

  const handleChange = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, '')
    if (!d) {
      setDigit(i, ' ')
      return
    }
    // Cas d'un collage de plusieurs chiffres
    if (d.length > 1) {
      const clean = d.slice(0, 6)
      onChange(clean)
      const focusIdx = Math.min(clean.length, 5)
      refs.current[focusIdx]?.focus()
      if (clean.length === 6 && onComplete) onComplete(clean)
      return
    }
    setDigit(i, d)
    if (i < 5) refs.current[i + 1]?.focus()
  }

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault()
      const arr = value.padEnd(6, ' ').slice(0, 6).split('')
      if (arr[i] && arr[i] !== ' ') {
        arr[i] = ' '
        onChange(arr.join('').replace(/\s/g, ''))
      } else if (i > 0) {
        arr[i - 1] = ' '
        onChange(arr.join('').replace(/\s/g, ''))
        refs.current[i - 1]?.focus()
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus()
    } else if (e.key === 'ArrowRight' && i < 5) {
      refs.current[i + 1]?.focus()
    }
  }

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3" role="group" aria-label={ariaLabel}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={1}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          aria-label={`Chiffre ${i + 1}`}
          value={d === ' ' ? '' : d}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onFocus={(e) => e.target.select()}
          className="h-14 w-11 sm:w-12 rounded-xl border border-input bg-secondary/40 text-center text-2xl font-bold text-foreground caret-primary outline-none transition-all focus:border-primary focus:bg-secondary/70 focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
        />
      ))}
    </div>
  )
}
