import React from 'react'

// Every page's title: big and tight, with the brand mark (index.css .ak-title).
export default function PageHeader({ title, subtitle, action, middle }) {
  return (
    <div className={`flex flex-col gap-3 mb-5 ${middle ? 'xl:flex-row xl:items-center xl:justify-between' : 'sm:flex-row sm:items-center sm:justify-between'}`}>
      <div className={middle ? 'min-w-0 xl:max-w-[36%] xl:shrink' : 'min-w-0 shrink-0'}>
        <h1 className={`ak-title ${middle ? 'xl:truncate' : ''}`} title={typeof title === 'string' ? title : undefined}><span className="ak-title-mark" aria-hidden="true" />{title}</h1>
        {/* A phone shows the title only (no line under it). */}
        {subtitle && <p className="hidden md:block text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>}
      </div>
      {middle && <div className="min-w-0 flex-1">{middle}</div>}
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
