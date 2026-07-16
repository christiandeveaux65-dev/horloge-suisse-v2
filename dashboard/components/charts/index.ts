'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import React from 'react'

const loading = () => React.createElement(Skeleton, { className: 'h-64 w-full rounded-lg' })

export const AreaSeries = dynamic(() => import('./area-series'), { ssr: false, loading })
export const Donut = dynamic(() => import('./donut'), { ssr: false, loading })
export const MultiLine = dynamic(() => import('./multi-line'), { ssr: false, loading })
export const Bars = dynamic(() => import('./bars'), { ssr: false, loading })
export const Sparkline = dynamic(() => import('./sparkline'), { ssr: false })
