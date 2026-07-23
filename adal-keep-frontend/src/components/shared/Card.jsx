import React from 'react'

export default function Card({ children, className = '', noPadding = false }) {
  return (
    <div className={`bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition-colors duration-300 ${noPadding ? '' : 'p-6'} ${className}`}>
      {children}
    </div>
  )
}