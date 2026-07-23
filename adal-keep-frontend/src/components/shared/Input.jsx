import React from 'react'

export default function Input({ 
  label, 
  error, 
  className = '', 
  id, 
  type = 'text',
  icon, // Pass an SVG element here for a left icon
  ...props 
}) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')

  return (
    <div className={`w-full ${className}`}>
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 transition-colors">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 dark:text-slate-500">
            {icon}
          </div>
        )}
        <input
          id={inputId}
          type={type}
          className={`w-full px-3.5 py-2.5 border rounded-xl shadow-sm text-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 
            dark:bg-slate-900 dark:text-white dark:border-slate-700 dark:placeholder-slate-500
            ${icon ? 'pl-10' : ''}
            ${error 
              ? 'border-red-300 dark:border-red-800 focus:ring-red-500/20 focus:border-red-500' 
              : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}
          `}
          {...props}
        />
      </div>
      {error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        {error}
      </p>}
    </div>
  )
}