'use client'

import { useEffect, useRef, useState } from 'react'

type Node = { x: number; y: number; vx: number; vy: number; r: number; hue: number }

const DEFAULT_MESSAGES = [
  'Connexion à la blockchain en cours…',
  'Synchronisation du portefeuille on-chain…',
  'Agrégation des positions multi-chain…',
  'Sécurisation de la session…',
]

/**
 * Écran de chargement plein écran, thème crypto / dark mode.
 * Rend un réseau de nœuds animé (blockchain) sur canvas + hexagone central pulsant.
 */
export function CryptoLoader({
  message,
  messages = DEFAULT_MESSAGES,
  className = '',
}: {
  message?: string
  messages?: string[]
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [msgIndex, setMsgIndex] = useState(0)

  // Rotation des messages (sauf si un message fixe est fourni)
  useEffect(() => {
    if (message) return
    const id = setInterval(() => setMsgIndex((i) => (i + 1) % messages.length), 1800)
    return () => clearInterval(id)
  }, [message, messages.length])

  // Animation du réseau de nœuds
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

    let raf = 0
    let w = 0
    let h = 0
    let dpr = 1
    let nodes: Node[] = []

    const build = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.min(70, Math.max(28, Math.floor((w * h) / 22000)))
      nodes = Array.from({ length: count }).map(() => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.8 + 1,
        hue: Math.random() > 0.5 ? 162 : 199,
      }))
    }

    const LINK = 150
    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      // Liens
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dist = Math.hypot(dx, dy)
          if (dist < LINK) {
            const alpha = (1 - dist / LINK) * 0.5
            ctx.strokeStyle = `hsla(${(a.hue + b.hue) / 2}, 80%, 55%, ${alpha})`
            ctx.lineWidth = 0.7
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }
      // Nœuds
      for (const n of nodes) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${n.hue}, 85%, 60%, 0.9)`
        ctx.shadowBlur = 12
        ctx.shadowColor = `hsla(${n.hue}, 85%, 55%, 0.8)`
        ctx.fill()
        ctx.shadowBlur = 0
        if (!reduce) {
          n.x += n.vx
          n.y += n.vy
          if (n.x < 0 || n.x > w) n.vx *= -1
          if (n.y < 0 || n.y > h) n.vy *= -1
        }
      }
      raf = requestAnimationFrame(draw)
    }

    build()
    draw()
    const onResize = () => build()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const shownMessage = message ?? messages[msgIndex]

  return (
    <div
      className={`fixed inset-0 z-[120] flex flex-col items-center justify-center overflow-hidden bg-[#07070c] ${className}`}
      role="status"
      aria-live="polite"
      aria-label="Chargement en cours"
    >
      {/* Réseau blockchain animé */}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      {/* Halo radial */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 45%, rgba(45,212,167,0.10), transparent 55%), radial-gradient(circle at 50% 45%, rgba(56,189,248,0.08), transparent 60%)',
        }}
        aria-hidden="true"
      />

      {/* Hexagone central pulsant */}
      <div className="relative z-10 flex flex-col items-center gap-8">
        <div className="relative h-32 w-32">
          <span className="cl-ring absolute inset-0 rounded-[28%] border border-primary/30" />
          <span className="cl-ring cl-ring-2 absolute inset-2 rounded-[28%] border border-accent/30" />
          <svg viewBox="0 0 100 100" className="cl-hex absolute inset-0 h-full w-full" aria-hidden="true">
            <defs>
              <linearGradient id="clg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#2dd4a7" />
                <stop offset="100%" stopColor="#38bdf8" />
              </linearGradient>
            </defs>
            <polygon
              points="50,6 88,28 88,72 50,94 12,72 12,28"
              fill="none"
              stroke="url(#clg)"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="cl-symbol font-display text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-br from-primary to-accent">
              ₿
            </span>
          </div>
        </div>

        <div className="flex flex-col items-center gap-4">
          <p className="min-h-[1.5rem] text-center text-sm font-medium text-foreground/90 transition-opacity">
            {shownMessage}
          </p>
          {/* Barre de progression indéterminée */}
          <div className="h-1 w-56 overflow-hidden rounded-full bg-white/5">
            <div className="cl-bar h-full w-1/3 rounded-full bg-gradient-to-r from-primary to-accent" />
          </div>
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="cl-dot h-1.5 w-1.5 rounded-full bg-primary" style={{ animationDelay: `${i * 0.18}s` }} />
            ))}
          </div>
        </div>
      </div>

      <style jsx>{`
        .cl-hex {
          animation: cl-spin 6s linear infinite;
          filter: drop-shadow(0 0 14px rgba(45, 212, 167, 0.45));
        }
        .cl-symbol {
          animation: cl-pulse 1.8s ease-in-out infinite;
        }
        .cl-ring {
          animation: cl-ringpulse 2.4s ease-out infinite;
        }
        .cl-ring-2 {
          animation-delay: 1.2s;
        }
        .cl-bar {
          animation: cl-slide 1.3s ease-in-out infinite;
        }
        .cl-dot {
          animation: cl-blink 1.2s ease-in-out infinite;
        }
        @keyframes cl-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes cl-pulse {
          0%,
          100% {
            transform: scale(1);
            opacity: 0.85;
          }
          50% {
            transform: scale(1.12);
            opacity: 1;
          }
        }
        @keyframes cl-ringpulse {
          0% {
            transform: scale(0.85);
            opacity: 0.6;
          }
          100% {
            transform: scale(1.25);
            opacity: 0;
          }
        }
        @keyframes cl-slide {
          0% {
            transform: translateX(-120%);
          }
          100% {
            transform: translateX(320%);
          }
        }
        @keyframes cl-blink {
          0%,
          100% {
            opacity: 0.25;
            transform: scale(0.8);
          }
          50% {
            opacity: 1;
            transform: scale(1.1);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .cl-hex,
          .cl-symbol,
          .cl-ring,
          .cl-bar,
          .cl-dot {
            animation-duration: 3s;
          }
        }
      `}</style>
    </div>
  )
}
