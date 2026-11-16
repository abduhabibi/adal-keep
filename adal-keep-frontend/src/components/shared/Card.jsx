import React from 'react'

// A card: solid, a hairline and a whisper of shadow (index.css .panel).
export default function Card({ children, className = '', noPadding = false }) {
  return (
    <div className={`panel ${noPadding ? '' : 'p-5 sm:p-6'} ${className}`}>
      {children}
    </div>
  )
}
