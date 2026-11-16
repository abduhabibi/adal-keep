/**
 * A CV page made into a PDF on this device (the phone with the office PC off,
 * asked on 2026-11-15): the phone app draws it with Android's own printing
 * (AdalDiscovery.htmlToPdf) and saves it to Downloads/Adal Keep; an older app
 * opens Android's print screen (Save as PDF); a browser its print window.
 */
const plugin = () => window.Capacitor?.Plugins?.AdalDiscovery

/** Saves (or prints) the page; says which: 'saved' | 'printing'. */
export async function pdfHere(html, name = 'CV.pdf') {
  const p = plugin()
  if (p?.htmlToPdf) {
    const r = await p.htmlToPdf({ html })
    if (r?.base64) {
      await p.saveFile({ base64: r.base64, name: /\.pdf$/i.test(name) ? name : `${name}.pdf`, mime: 'application/pdf', open: true })
      return 'saved'
    }
  }
  if (p?.printHtml) { await p.printHtml({ html }); return 'printing' }
  const w = window.open('', '_blank')
  if (!w) throw new Error('Allow pop-ups to print the CV')
  w.document.open(); w.document.write(html); w.document.close()
  w.onload = () => setTimeout(() => w.print(), 300)
  return 'printing'
}
