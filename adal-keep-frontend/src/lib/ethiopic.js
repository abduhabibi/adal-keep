/**
 * Ethiopian touches for the pages: today's date in the Ethiopian calendar,
 * Ge'ez numbers and the Amharic greeting for the time of day.
 * Pure arithmetic: nothing is fetched, nothing animates.
 */

const MONTHS = ['መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜን']
const DAYS = ['እሑድ', 'ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'ዓርብ', 'ቅዳሜ']

// Gregorian → Julian day number.
function jdn(y, m, d) {
  const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
}

/** The Ethiopian date (Amete Mihret) of a JavaScript date. */
export function ethiopianDate(date = new Date()) {
  const j = jdn(date.getFullYear(), date.getMonth() + 1, date.getDate())
  const r = (j - 1723856) % 1461
  const n = (r % 365) + 365 * Math.floor(r / 1460)
  const year = 4 * Math.floor((j - 1723856) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460)
  const month = Math.floor(n / 30) + 1
  const day = (n % 30) + 1
  return { year, month, day, monthName: MONTHS[month - 1], weekday: DAYS[date.getDay()] }
}

const ONES = ['', '፩', '፪', '፫', '፬', '፭', '፮', '፯', '፰', '፱']
const TENS = ['', '፲', '፳', '፴', '፵', '፶', '፷', '፸', '፹', '፺']

/** A whole number in Ge'ez numerals (0 stays "0": Ge'ez has no zero). */
export function geez(num) {
  let n = Math.floor(Number(num) || 0)
  if (n <= 0) return '0'
  const pairs = []
  while (n > 0) { pairs.unshift(n % 100); n = Math.floor(n / 100) }
  let out = ''
  pairs.forEach((p, i) => {
    const pos = pairs.length - 1 - i            // 0 = the last pair
    const leadingOne = p === 1 && i === 0 && pos > 0
    if (p && !leadingOne) out += TENS[Math.floor(p / 10)] + ONES[p % 10]
    if (pos > 0 && (p || pos % 2 === 0)) out += pos % 2 ? '፻' : '፼'
  })
  return out
}

/** "Good morning / day / evening" in Amharic. */
export function greeting(date = new Date()) {
  const h = date.getHours()
  if (h < 12) return 'እንደምን አደሩ'
  if (h < 18) return 'እንደምን ዋሉ'
  return 'እንደምን አመሹ'
}
