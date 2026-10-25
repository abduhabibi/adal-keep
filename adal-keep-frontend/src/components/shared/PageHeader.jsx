import React from 'react'

export default function PageHeader({ title, subtitle, action, middle }) {
  return (
    <div className={`flex flex-col gap-4 mb-6 ${middle ? 'xl:flex-row xl:items-center xl:justify-between' : 'sm:flex-row sm:items-center sm:justify-between'}`}>
      <div className="shrink-0">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{subtitle}</p>}
      </div>
      {middle && <div className="min-w-0 flex-1">{middle}</div>}
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}