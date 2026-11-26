import React from 'react'
import { useNavigate } from 'react-router-dom'
import StopX, { goBack } from './StopX'

/**
 * The wheel. onStop: the X beside it does that; back: the X goes back to where the person was
 * (a whole page that is coming). label: words beside it.
 */
export default function Spinner({ size = 'md', className = '', onStop = null, back = false, label = '' }) {
  const sizeClasses = {
    sm: 'w-4 h-4 border-2',
    md: 'w-8 h-8 border-3',
    lg: 'w-12 h-12 border-4',
  }
  return (
    <div className={`flex items-center justify-center gap-3 ${className}`} data-testid="spinner">
      <div className={`${sizeClasses[size]} border-t-teal-600 border-gray-200 rounded-full animate-spin`}></div>
      {label && <span className="text-sm text-slate-500">{label}</span>}
      {(onStop || back) && <SpinnerX onStop={onStop} back={back} />}
    </div>
  )
}
function SpinnerX({ onStop, back }) {
  const navigate = useNavigate()
  return <StopX title={back && !onStop ? 'Stop — back to where you were' : 'Stop'} onStop={onStop || (() => goBack(navigate))} />
}
