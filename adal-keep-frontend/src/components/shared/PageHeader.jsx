import React from 'react'

// Every page's title: big and tight (index.css .ak-title). `subtitle` is accepted and not shown.
export default function PageHeader({ title, subtitle, action, middle }) {
  return (
    <div className={`flex flex-col gap-3 mb-5 ${middle ? 'xl:flex-row xl:items-center xl:justify-between' : 'sm:flex-row sm:items-center sm:justify-between'}`}>
      <div className={middle ? 'min-w-0 xl:max-w-[36%] xl:shrink' : 'min-w-0 shrink-0'}>
        <h1 className={`ak-title ${middle ? 'xl:truncate' : ''}`} title={typeof title === 'string' ? title : undefined}>{title}</h1>
        {/* No line under the title (2026-11-19: less text on every page). */}
      </div>
      {middle && <div className="min-w-0 flex-1">{middle}</div>}
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
