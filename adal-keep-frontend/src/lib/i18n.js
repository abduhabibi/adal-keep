/**
 * Language: English (the default, always), Amharic or Arabic (right to left), chosen in
 * Settings for each employee (the PC's own choice before anyone is signed in).
 *
 * The pages are written in Amharic or in English, and this layer shows them in the
 * chosen language. English: every known Amharic phrase on screen (text, placeholders,
 * titles) is shown in English. Amharic: the English labels (lib/i18n/labels.js and AM
 * below) are shown in Amharic. Arabic: Amharic text goes through English first, then
 * every known English phrase is shown in Arabic (lib/i18n/ar-from-english.js, labels.js)
 * and the page turns right to left. Only whole phrases are replaced, never parts of
 * words, and nothing inside [translate="no"] (chat messages, people's data) is touched.
 * Government terms (Musaned, LMIS, EPRO, Wafid) stay as they are in every language.
 * Choosing a language reloads the page.
 */
import { AR_FROM_ENGLISH } from './i18n/ar-from-english.js'
import { LABELS } from './i18n/labels.js'

export const LANGS = ['en', 'am', 'ar']
const PC_KEY = 'adal-lang-v2'   // the PC's own choice (English until someone picks another)
const userKey = () => {
  try { const e = JSON.parse(localStorage.getItem('adal_active_employee') || 'null'); return e?.id != null ? `adal-lang-v3:${e.id}` : null } catch { return null }
}
const clean = (v) => (LANGS.includes(v) ? v : null)

/** The language of the employee signed in here, else the PC's, else English. */
export function getLang() {
  try { return clean(localStorage.getItem(userKey() || '-')) || clean(localStorage.getItem(PC_KEY)) || 'en' } catch { return 'en' }
}

let running = null
export function setLang(lang) {
  lang = clean(lang) || 'en'
  try {
    const k = userKey()
    if (k) localStorage.setItem(k, lang)
    else localStorage.setItem(PC_KEY, lang)
  } catch {}
  window.location.reload()
}

/** An employee signed in or out: their own language (reloads only when it differs). */
export function followUser() {
  if (running && getLang() !== running) window.location.reload()
}

const EN = {
  'የፓስፖርቱን ፎቶ ያንሱ — ቀሪው ራሱ ይሞላል።': 'Take a photo of the passport — the rest fills in by itself.',
  'ካቆሙበት ይቀጥሉ': 'Continue where you left off',
  'ለመስራት ተግባሮች': 'Tasks to do',
  'ዛሬ መደረግ ያለባቸው': 'Needs action today',
  'ገጽ': 'Page',
  'ማስታወሻዎች': 'Notes',
  'ሁሉም ማሳወቂያዎች ተጽድተዋል': 'All notifications cleared',
  'ሁሉም ማሳወቂያዎች ይሰረዙ?': 'Delete all notifications?',
  'ሁሉም ተመድበዋል': 'All assigned',
  'ሁሉም ደላሎች': 'All brokers',
  'ሁሉም ፕሮፋይሎች': 'All profiles',
  'ሁሉንም ሁኔታዎች': 'All statuses',
  'ሁሉንም ለመሰራት ተግባሮች ይሰረዙ?': 'Delete all to-do tasks?',
  'ሁሉንም አጽዳ': 'Clear all',
  'ሁሉንም ይመልከቱ': 'See all',
  'ሁሉንም ደላሎች': 'All brokers',
  'ሁሉንም ደንበኞች': 'All clients',
  'ሁኔታ': 'Status',
  'ለመሰራት': 'To do',
  'ለመሰራት ተግባሮች ተሰርዘዋል': 'To-do tasks deleted',
  'ለመስራት': 'To do',
  'ለመግባት ጠቅ ያድርጉ': 'Click to sign in',
  'ለማከል ፕሮይሎችን እዚህ ያስቀምጡ': 'Drop profiles here to add them',
  'ለምሳሌ': 'for example',
  'ለወጦችን አስቀምጥ': 'Save changes',
  'ለዝርዝር ጠቅ ያድርጉ': 'Click for details',
  'መለያ ስም': 'Username',
  'መለያ ስም ያለ ክፍተት': 'Username without spaces',
  'መልክ': 'Appearance',
  'መልክ፣ አውታረ መረብ፣ ምዝገባ እና ማሻሻያዎች': 'Appearance, network, registration and updates',
  'መመደብ አልተቻለም': 'Could not assign',
  'መረጃ መጫን አልተቻለም': 'Could not load the data',
  'መረጃችን መጫን አልተቻለም': 'Could not load the data',
  'መሰረዝ አልተቻለም': 'Could not delete',
  'መቀመጥ አልተቻለም': 'Could not save',
  'መግባት አልተቻለም': 'Could not sign in',
  'ሙሉ ስም': 'Full name',
  'ሙከራ': 'Trial',
  'ማሳወቂያ መሰረዝ አልተቻለም': 'Could not delete the notification',
  'ማሳወቂያ ተሰርዟል': 'Notification deleted',
  'ማሳወቂያዎች': 'Notifications',
  'ማሳወቂያዎችን ማጽዳት አልተቻለም': 'Could not clear the notifications',
  'ማስተካከያዎች': 'Settings',
  'ማስታወሻዎች': 'Notes',
  'ማስወገድ አልተቻለም': 'Could not remove',
  'ማሻሻያዎች': 'Updates',
  'ማሻሻያዎች፣ የስርዓት ማንቂያዎች እና የሰራተኛ መልእክቶች': 'Updates, system alerts and employee messages',
  'ማዘመን አልተቻለም': 'Could not update',
  'ማገናኛ አርትዕ': 'Edit link',
  'ማጥፋት አልተቻለም': 'Could not delete',
  'ሜኑ': 'Menu',
  'ምንም ማሳወቂያ የለም': 'No notifications',
  'ምንም አልተገኘም': 'Nothing found',
  'ምንም ደላላ አልተገኘም': 'No broker found',
  'ምንም ፕሮፋይል አልተገኘም።': 'No profile found.',
  'ምንም ፕሮፋይል አልተገኘም': 'No profile found',
  'ምንም ፕሮፋይል የለም': 'No profiles',
  'ምዝገባ': 'Registration',
  'ሰራተኛ ተዘምኗል': 'Employee updated',
  'ሰራተኛ ተፈጥሯል': 'Employee created',
  'ሰራተኛ አርም': 'Edit employee',
  'ሰራተኛ አክል': 'Add employee',
  'ሰራተኞች': 'Employees',
  'ሰራተኞችን መጫን አልተቻለም': 'Could not load the employees',
  'ሰርዝ': 'Delete',
  'ሲቪዎች': 'CVs',
  'ሳይድባር ቀይር': 'Toggle sidebar',
  'ስለዚህ ደንበኛ ጠቃሚ የሆኑ መረጃዎች…': 'Useful notes about this client…',
  'ስልክ ቁጥር': 'Phone number',
  'ስልክ የለም': 'No phone',
  'ስልክ': 'Phone',
  'ስም ያስፈልጋል': 'Name is required',
  'ስም': 'Name',
  'ቀለማት': 'Colours',
  'ቅዳ': 'Copy',
  'በሂደት ላይ': 'In progress',
  'በሂደት': 'In progress',
  'በመጠባበቅ ላይ': 'Pending',
  'በመጠባበቅ': 'Pending',
  'በመጫን ላይ…': 'Loading…',
  'በማስቀመጥ ላይ…': 'Saving…',
  'በስም፣ በስልክ ወይም በመታወቂያ ይፈልጉ': 'Search by name, phone or ID',
  'ብሔራዊ መታወቂያ': 'National ID',
  'ብርሃን': 'Light',
  'ቦታ': 'Location',
  'ተመለስ': 'Back',
  'ተመድቧል': 'Assigned',
  'ተሰርዟል': 'Deleted',
  'ተቀርጧል': 'Rejected',
  'ተዘምኗል': 'Updated',
  'ተግባራት': 'Tasks',
  'ተግባር የለም': 'No tasks',
  'ተግባር': 'Task',
  'ተግባሮች': 'Tasks',
  'ተግባሮችን መጫን አልተቻለም': 'Could not load the tasks',
  'ተግባሮችን ይጎትቱ፣ ያጽድቁ እና ያጠናቁ': 'Drag, approve and complete tasks',
  'ተጠናቋል': 'Done',
  'ቻት': 'Chat',
  'ቼክሊስት መፍር አልተቻለም': 'Could not create the checklist',
  'ቼክሊስት': 'Checklist',
  'ቼክስቱ ተሰርዟል': 'Checklist deleted',
  'ቼክስቱን ርዝ': 'Delete the checklist',
  'ቼክስቱን ጥፋት አልተቻለም': 'Could not delete the checklist',
  'ቼክስት ተጥል': 'Checklist created',
  'ቼክስት': 'Checklist',
  'ንቁ': 'Active',
  'አመቻቾች': 'Brokers',
  'አርም': 'Edit',
  'አርትዕ': 'Edit',
  'አስቀምጥ': 'Save',
  'አስወግድ': 'Remove',
  'አንቃ': 'Enable',
  'አካባቢያዊ': 'Local',
  'አውታረ መረብ': 'Network',
  'አዲስ ማገናኛ ጨምር': 'Add a new link',
  'አዲስ ሰራተኛ': 'New employee',
  'አዲስ የቼክሊስት ስም': 'New checklist name',
  'አዲስ ደላላ አክል': 'Add a new broker',
  'አዲስ ደንበኛ ወደ ስራ ቦታዎ ያክሉ': 'Add a new client to your workspace',
  'አዲስ ፕሮፋይል ተፈጥሯል': 'New profile created',
  'አዲስ ፕሮፋይል': 'New profile',
  'አድራሻ': 'Address',
  'አጉላ': 'Zoom',
  'አጠቃላይ እይታ': 'Overview',
  'አጽድቅ': 'Approve',
  'እስካሁን ምንም ቼክሊስት የለም።': 'No checklist yet.',
  'እስካሁን ደላላ የለም': 'No broker yet',
  'እባክዎ ማጣሪያዎችን ያጽዱ ወይም ሌላ ነገር ይፈልጉ።': 'Please clear the filters or search for something else.',
  'እንኳን ደህና መጡ፣': 'Welcome,',
  'እንኳን ደህና መጡ፤': 'Welcome;',
  'እዚህ ይጣሉ': 'Drop here',
  'ከሰራተኞች ገጽ ይፍጠሩ': 'Create them on the Employees page',
  'ከዚህ ቼክስት አስግድ': 'Remove from this checklist',
  'ከደላላ ተነጥሏል': 'Removed from the broker',
  'ካርዱን ጠቅ በማድረግ ይግቡ': 'Click the card to sign in',
  'ወደ የተመደቡ ይጨመራል': 'is added to the assigned',
  'ውድቅ': 'Reject',
  'ውጣ': 'Sign out',
  'ዝርዝር ለማየት ጠቅ ያድርጉ': 'Click to see the details',
  'የለም': 'None',
  'የሚጠብቁ ተግባራት አሉዎት': 'pending tasks waiting for you',
  'የሰነዶች እና የሁኔታ ክትትል ለመጀመር የደንበኛ ፕሮፋይል ያክሉ።': 'Add a client profile to start tracking documents and status.',
  'የስራ ስልክ': 'Work phone',
  'የስራ ቦታ': 'Workspace',
  'የስርዓት ቅንብሮች': 'System settings',
  'የስርዓት አጠቃላይ እይታ': 'System overview',
  'የቅርብ ጊዜ ፕሮፋይሎች': 'Recent profiles',
  'የተመደቡ ፕሮፋይሎች': 'Assigned profiles',
  'የተጠናቀቀ': 'Completed',
  'የቼክሊስት አቀናባሪ': 'Checklist manager',
  'የኔ ቼክስቶች': 'My checklists',
  'የአመቻች ዝርዝር': 'Broker list',
  'የአካባቢ የስራ ቦታ': 'Local workspace',
  'የአውታረ መረብ': 'Network',
  'የኤጀንሲ ቅንብሮች': 'Agency settings',
  'የክትትል ዝርዝር': 'Watch list',
  'የይለፍ ቃል አያስፈልግም': 'No password needed',
  'የደላላ መረጃ': 'Broker details',
  'የደላላ ስም ያስፈልጋል': 'Broker name is required',
  'የደላላ ስም': 'Broker name',
  'የደንበኛ ዝርዝሮችን ያዘምኑ': 'Update the client details',
  'የጀርባ ምስል': 'Background picture',
  'የፎርም መረጃዎችን መጫን አልተቻለም': 'Could not load the form data',
  'የፕሮፋይል ዝርዝር': 'Profile list',
  'ያልተመደበ': 'Unassigned',
  'ያልተመደቡ': 'Unassigned',
  'ይህ ሰራተኛ ገና ፕሮፋይል አልፈጠረም': 'This employee has not created a profile yet',
  'ይህ ተግባር ይሰረዝ?': 'Delete this task?',
  'ይህ ተግባር ይቀር?': 'Reject this task?',
  'ይህን ማገናኛ ማጥፋት ይፈልጋሉ?': 'Delete this link?',
  'ይህንን ፕሮፋይል ሙሉ በሙሉ ለማጥፋት እርግጠኛ ነዎት?': 'Are you sure you want to delete this profile completely?',
  'ይመልከቱ': 'View',
  'ይሰረዝ? ይህ ፕሮፋይሎቹን አያጠፋም': 'Delete? This does not delete the profiles',
  'ይሰረዝ?': 'Delete?',
  'ደላላ ተሰርዟል': 'Broker deleted',
  'ደላላ ተዘምኗል': 'Broker updated',
  'ደላላ ተፈጥሯል': 'Broker created',
  'ደላላ አርም': 'Edit broker',
  'ደላላ አክል ይጫኑ': 'Press Add broker',
  'ደላላ አክል': 'Add broker',
  'ደላላ የለም': 'No broker',
  'ደላላ ይፈልጉ': 'Search brokers',
  'ደላላ': 'Broker',
  'ደላሎችን መጫን አልተቻለም': 'Could not load the brokers',
  'ደላሎች እና ፕሮፋይሎች': 'Brokers and profiles',
  'ደላሎች': 'Brokers',
  'ዳሽቦርድ': 'Dashboard',
  'ዳግም ጫን': 'Reload',
  'ገና ሰራተኛ የለም': 'No employees yet',
  'ጊዜው አልፏል': 'Expired',
  'ጎትት ወይም ጠቅ አድርግ': 'Drag or click',
  'ጨለማ': 'Dark',
  'ጨምር': 'Add',
  'ጸድቋል': 'Approved',
  'ፈልግ': 'Search',
  'ፍጠር': 'Create',
  'ፓስፖርት ቁጥር': 'Passport number',
  'ፓስፖርት': 'Passport',
  'ፕሪሚየም': 'Premium',
  'ፕሮይሉ ቼክስቱ ወግዷል': 'Profile removed from the checklist',
  'ፕሮፋይሉ በስኬት ተዘምኗል': 'Profile updated',
  'ፕሮፋይሉ ተሰርዟል': 'Profile deleted',
  'ፕሮፋይሉን መጫን አልተቻለም': 'Could not load the profile',
  'ፕሮፋይሉን ማስቀመጥ አልተቻለም': 'Could not save the profile',
  'ፕሮፋይሉን ማንሳት አልተቻለም': 'Could not remove the profile',
  'ፕሮፋይሉን ማከል አልተቻለም': 'Could not add the profile',
  'ፕሮፋይሉ ወደ ቼክስቱ ተጨምሯል': 'Profile added to the checklist',
  'ፕሮፋይል በመጫን ላይ…': 'Loading the profile…',
  'ፕሮፋይል ተመድቧል': 'Profile assigned',
  'ፕሮፋይል አርም': 'Edit profile',
  'ፕሮፋይል አክል': 'Add profile',
  'ፕሮፋይል ፍጠር': 'Create profile',
  'ፕሮፋይል': 'Profile',
  'ፕሮፋይሎቹ አይጠፉም።': 'The profiles are kept.',
  'ፕሮፋይሎች ተጠብቀዋል': 'Profiles kept',
  'ፕሮፋይሎችን መጫን አልተቻለም': 'Could not load the profiles',
  'ፕሮፋይሎችን ወደ ክሊስቶች ይጎትቱ': 'Drag profiles onto checklists',
  'ፕሮፋይሎች': 'Profiles',
  'ሕክምና': 'Medical',
  'ብቁ': 'Fit',
  'ተመዝግቧል': 'Applied',
  // a few phrases written with other spellings / forms on the pages
  'የተመደቡ ፕሮፋይሎች ': 'Assigned profiles ',
  'ፕሪሚየም CRM': 'Premium CRM',
  // The new look (2026-11-16): home page, menu, top bar.
  'እንደምን አደሩ': 'Good morning',
  'እንደምን ዋሉ': 'Good afternoon',
  'እንደምን አመሹ': 'Good evening',
  'እንኳን ደህና መጡ': 'Welcome',
  'አዲስ ፕሮፋይል': 'New profile',
  'አዲስ ሲቪ': 'New CV',
  'ዛሬ': 'Today',
  'ጉዞ': 'Journey',
  'አዲስ አበባ': 'Addis Ababa',
  'ሪያድ': 'Riyadh',
  'መጣያ': 'Trash',
  'የሮቦት ታሪክ': 'Robot history',
  'ፍለጋውን ደብቅ': 'Hide search',
  'ፕሮፋይሎችን ፈልግ': 'Search profiles',
  'የተመረጡ': 'Selected',
  'ምትኬ በመያዝ ላይ': 'Backing up',
  'ምትኬ': 'Backup',
  'የገቢ መልእክት': 'Inbox',
  // The phone's tabs, top bar and More page.
  'መነሻ': 'Home',
  'ተጨማሪ': 'More',
  'የሲቪ ቅጦች': 'CV templates',
  'አመቻች': 'Broker',
  'ሥራ': 'Work',
  'የእርስዎ ኤጀንሲ': 'Your agency',
  // New profile: start with the passport.
  'የፓስፖርቱን ገጽ እዚህ ይጎትቱ — ከትሪው፣ ከዴስክቶፕ ወይም ከቴሌግራም — ወይም ይለጥፉ': 'Drag the passport page here — from the tray, the desktop or Telegram — or paste it',
  'ወይም': 'or',
  'ከዚህ ኮምፒውተር ይምረጡ': 'choose it from this PC',
  'ስም፣ የፓስፖርት ቁጥር፣ የልደት ቀን፣ ጾታ እና የትውልድ ቦታ ራሳቸው ይሞላሉ።': 'Name, passport number, birth date, sex and place of birth fill in by themselves.',
  // CV templates.
  'እያንዳንዱ ቅጥ ለፕሮፋይሉ መረጃዎች': 'Each template is a hand-authored HTML/CSS layout with',
  'ያሉት በእጅ የተጻፈ HTML/CSS ቅርጽ ነው።': 'for the profile fields.',
  'ቅጥ ፍጠር': 'Create template',
  'ቅጦች — እያንዳንዱ አንድ ኤጀንሲ ነው': 'template(s) — each one is an agency',
  'ይጫኑት፦ የኤጀንሲውን ራስጌ ይስቀሉ፣ ሁለት ቀለሞችና አንድ ንድፍ ይምረጡ፤ የፓስፖርቱ ገጽ ሁሌም ይካተታል።': "click it: upload the agency's header, pick two colours and one of the designs; the passport page is always included.",
  'በማንኛውም ካርድ ላይ ይቀይረዋል፤': 'on any card changes it;',
  'HTML ጻፍ': 'Write HTML',
  'በእጅ ለሚሠራ ቅርጽ ነው።': 'is for a hand-made layout.',
  // The Ethiopian calendar's months and the days of the week (today's date on the home page).
  'መስከረም': 'Meskerem', 'ጥቅምት': 'Tikimt', 'ኅዳር': 'Hidar', 'ታኅሣሥ': 'Tahsas', 'ጥር': 'Tir', 'የካቲት': 'Yekatit',
  'መጋቢት': 'Megabit', 'ሚያዝያ': 'Miyazya', 'ግንቦት': 'Ginbot', 'ሰኔ': 'Sene', 'ሐምሌ': 'Hamle', 'ነሐሴ': 'Nehase', 'ጳጉሜን': 'Pagume',
  'እሑድ': 'Sunday', 'ሰኞ': 'Monday', 'ማክሰኞ': 'Tuesday', 'ረቡዕ': 'Wednesday', 'ሐሙስ': 'Thursday', 'ዓርብ': 'Friday', 'ቅዳሜ': 'Saturday',
}

const ETHIOPIC = /[ሀ-፿]/
let rules = null
function compile() {
  // Longest first, and only whole phrases (no Ethiopic letter just before/after).
  const keys = Object.keys(EN).sort((a, b) => b.length - a.length)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  rules = new RegExp(`(?<![\\u1200-\\u137F])(${keys.map(esc).join('|')})(?![\\u1200-\\u137F])`, 'g')
}
function tr(text) {
  if (!text || !ETHIOPIC.test(text)) return text
  if (!rules) compile()
  return text.replace(rules, (m) => EN[m] ?? m)
}

function skip(node) {
  const el = node.nodeType === 1 ? node : node.parentElement
  return !el || !!el.closest('[translate="no"], script, style, textarea, [contenteditable="true"]')
}
/**
 * Amharic for the labels that were written in English. Only a whole label
 * (a text, placeholder or title that is exactly one of these) is replaced, so
 * names and other data are never touched, and nothing inside [translate="no"].
 */
const AM = {
  // A girl's steps after the EPRO (ProfileAutomations: the steps row).
  'Drag a step to change the order — every girl follows it. Done steps fold away.': 'ቅደም ተከተሉን ለመቀየር አንድን ደረጃ ይጎትቱ — ሁሉም ልጃገረዶች ይከተሉታል። የተጠናቀቁ ደረጃዎች ይታጠፋሉ።',
  '✓ Every step is done.': '✓ ሁሉም ደረጃዎች ተጠናቀዋል።',
  // Profiles
  'Wakala': 'ዋካላ', '✓ Paid': '✓ ተከፍሏል', '⏳ Unpaid': '⏳ አልተከፈለም', 'Selected': 'ተመርጧል',
  'Insurance': 'ኢንሹራንስ', 'Embassy': 'ኤምባሲ', 'Visa': 'ቪዛ', 'Arrived': 'ደርሳለች',
  '🔎 Check for new selections': '🔎 አዲስ ምርጫዎችን ፈልግ', '🔎 Checking…': '🔎 በመፈለግ ላይ…', '⚙ Filters': '⚙ ማጣሪያዎች', '⚙ Filters ▾': '⚙ ማጣሪያዎች ▾',
  'profiles': 'ፕሮፋይሎች', 'Sort by:': 'ደርድር በ:', 'Recent (opened or updated)': 'የቅርብ (የተከፈቱ ወይም የተቀየሩ)',
  'Date Added': 'የተጨመረበት ቀን', 'Name': 'ስም', 'Age': 'ዕድሜ', 'Pending': 'በመጠባበቅ ላይ', 'Active': 'ንቁ',
  'Profiles — search': 'ፕሮፋይሎች — ፍለጋ', 'All profiles — search': 'ሁሉም ፕሮፋይሎች — ፍለጋ', 'All': 'ሁሉም',
  'Running': 'በመሥራት ላይ', 'Not running': 'የማይሠሩ', 'Name, passport, labor ID…  (Ctrl+K)': 'ስም፣ ፓስፖርት፣ የሠራተኛ መታወቂያ…  (Ctrl+K)',
  // New profile
  'Start with the passport — the form fills itself': 'በፓስፖርት ይጀምሩ — ቅጹ ራሱ ይሞላል', 'Start with the passport': 'በፓስፖርት ይጀምሩ',
  'Camera': 'ካሜራ', 'Gallery': 'ጋለሪ', 'Files': 'ፋይሎች', 'choose it from this PC': 'ከዚህ ኮምፒውተር ይምረጡ',
  'The passport is saved on the profile when you press Create.': '«ፍጠር»ን ሲጫኑ ፓስፖርቱ በፕሮፋይሉ ላይ ይቀመጣል።',
  'No passport yet — fill the form by hand': 'ገና ፓስፖርት የለም — ቅጹን በእጅ ይሙሉ',
  // CVs
  'All generated CVs': 'ሁሉም የተዘጋጁ ሲቪዎች', 'Templates': 'ቅጦች', '📥 Add from Musaned': '📥 ከMusaned አክል', '+ New CV': '+ አዲስ ሲቪ',
  'No CVs yet': 'ገና ሲቪ የለም', 'Click New CV to pick a candidate and generate a formatted CV': 'ዕጩ ለመምረጥና ሲቪ ለማዘጋጀት «አዲስ ሲቪ»ን ይጫኑ',
  'Create first CV': 'የመጀመሪያውን ሲቪ ፍጠር', 'New CV — pick profile': 'አዲስ ሲቪ — ፕሮፋይል ይምረጡ',
  'Search by name, phone, or passport': 'በስም፣ በስልክ ወይም በፓስፖርት ይፈልጉ', 'Cancel': 'ተው', 'Passport:': 'ፓስፖርት:', 'Broker:': 'ደላላ:',
  'CV Templates': 'የሲቪ ቅጦች', '← CVs': '← ሲቪዎች', 'Write HTML…': 'HTML ጻፍ…', '🎨 Create template': '🎨 ቅጥ ፍጠር', 'Edit': 'አርም',
  'No header image': 'የራስጌ ምስል የለም', 'Preview': 'ቅድመ እይታ', 'Off': 'ጠፍቷል', 'Del': 'ሰርዝ',
  // Tasks, chat, documents
  'Documents': 'ሰነዶች', 'watching Downloads for new files': 'አዲስ ፋይሎችን በ Downloads እየተከታተለ', 'Remove all': 'ሁሉንም አስወግድ',
  'approval': 'ፈቃድ', 'The chat is not connected on this PC yet': 'ቻቱ በዚህ ኮምፒውተር ላይ ገና አልተገናኘም',
  // Employees
  '🔑 Sign-in for other computers': '🔑 ለሌሎች ኮምፒውተሮች መግቢያ', '＋ Add': '＋ አክል',
  // Settings
  'Agency': 'ኤጀንሲ', 'Plan': 'ዕቅድ', 'Portals': 'ፖርታሎች', 'Integrations': 'ውህደቶች', 'Transitions': 'ሽግግሮች',
  'Backup & updates': 'ምትኬ እና ማሻሻያዎች', 'Look & language': 'መልክ እና ቋንቋ',
  'Agency Email (for Musaned/Notifications)': 'የኤጀንሲ ኢሜይል (ለMusaned/ማሳወቂያዎች)', 'Save Settings': 'ቅንብሮችን አስቀምጥ',
  'PC number': 'የኮምፒውተር ቁጥር', 'Software Updates': 'የሶፍትዌር ማሻሻያዎች', 'Update by itself': 'ራሱ ይዘምን',
  'Check GitHub for the latest version and install it': 'አዲሱን ስሪት ፈልገው ይጫኑ', 'Check for Updates': 'ማሻሻያ ፈልግ',
  'This email will be used as the default contact for automated workflows like Musaned.': 'ይህ ኢሜይል እንደ Musaned ላሉ ራስ-ሰር ሥራዎች ዋና መገናኛ ሆኖ ያገለግላል።',
  '— a new version installs as soon as no automation run is working (checked every 15 minutes)': '— ምንም ሮቦት በማይሠራበት ጊዜ አዲስ ስሪት ራሱ ይጫናል (በየ15 ደቂቃው ይፈተሻል)',
  'Click New CV to pick a candidate and generate a formatted CV for one of your agencies.': '«አዲስ ሲቪ»ን ይጫኑ፤ ዕጩ ይምረጡና ለአንዱ ኤጀንሲዎ የተዘጋጀ ሲቪ ያውጡ።',
  'No new documents today. Save a passport, slip or photo into Downloads and it shows up here within a few seconds.': 'ዛሬ አዲስ ሰነድ የለም። ፓስፖርት፣ ስሊፕ ወይም ፎቶ ወደ Downloads ያስቀምጡ፤ በጥቂት ሰከንዶች ውስጥ እዚህ ይታያል።',
  'No templates yet': 'ገና ቅጥ የለም', 'Click New Template to create your first agency layout.': 'የመጀመሪያውን የኤጀንሲ ቅጥ ለመፍጠር «ቅጥ ፍጠር»ን ይጫኑ።',
  'Not available in the demo': 'በማሳያው ላይ አይገኝም',
  'Light': 'ብሩህ', 'Dark': 'ጨለማ', 'Gradient': 'ቅልመት', 'No wallpaper': 'የግድግዳ ምስል የለም', 'Upload wallpaper': 'የግድግዳ ምስል ስቀል',
}
const LATIN = /[A-Za-z]/
const AMHARIC = { ...Object.fromEntries(LABELS.filter(l => l[1]).map(l => [l[0], l[1]])) }
const AM_ALL = { ...AM, ...AMHARIC }
const GOV_AM = [[/ሙሳነድ/g, 'Musaned'], [/ዋፊድ/g, 'Wafid'], [/ኤልኤምአይኤስ/g, 'LMIS']]
const AR = { ...Object.fromEntries(AR_FROM_ENGLISH), ...Object.fromEntries(LABELS.map(l => [l[0], l[2]])) }
let arRules = null
function arCompile() {
  const keys = Object.keys(AR).filter(k => k.length >= 6).sort((a, b) => b.length - a.length)
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  arRules = new RegExp(`(?<![A-Za-z])(${keys.map(esc).join('|')})(?![A-Za-z])`, 'g')
}

function trAm(text) {
  if (!text) return text
  let out = text
  if (ETHIOPIC.test(out)) for (const [re, to] of GOV_AM) out = out.replace(re, to)
  if (LATIN.test(out)) { const t = out.trim(), hit = AM_ALL[t]; if (hit) out = out.replace(t, hit) }
  return out
}
/** Arabic: a phrase written in English is exactly one of the known labels; Amharic text goes through English first (every known phrase in it). */
function trAr(text) {
  if (!text) return text
  const fromAmharic = ETHIOPIC.test(text)
  const en = fromAmharic ? tr(text) : text
  if (!LATIN.test(en)) return en
  const t = en.trim(), hit = AR[t]
  if (hit) return en.replace(t, hit)
  if (!fromAmharic) return text
  if (!arRules) arCompile()
  return en.replace(arRules, (m) => AR[m] ?? m)
}

/** The text as the language shows it (pure: used by the layer below and by the tests). */
export function translateText(text, lang) {
  if (lang === 'am') return trAm(text)
  if (lang === 'ar') return trAr(text)
  return tr(text)
}

const ATTRS = ['placeholder', 'title', 'aria-label']
const SEL = '[translate="no"], script, style, textarea'
function layer(lang) {
  const fn = (t) => translateText(t, lang)
  const attrs = (el) => { for (const a of ATTRS) { const v = el.getAttribute?.(a); if (v) { const t = fn(v); if (t !== v) el.setAttribute(a, t) } } }
  const textNode = (n) => { if (!skip(n)) { const t = fn(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t } }
  const tree = (root) => {
    if (root.nodeType === 3) return textNode(root)
    if (root.nodeType !== 1 || skip(root)) return
    attrs(root)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) { if (!n.closest(SEL)) attrs(n) } else textNode(n)
    }
  }
  return tree
}

/**
 * The browser's own boxes (confirm, alert, prompt) in the app's language too (asked on
 * 2026-11-23: "Remove all" asked in Amharic only): their text goes through the same words.
 */
export function speakDialogs(lang, w = typeof window !== 'undefined' ? window : null) {
  if (!w || w.__adalDialogsIn === lang) return
  const orig = w.__adalDialogs || (w.__adalDialogs = { confirm: w.confirm?.bind(w), alert: w.alert?.bind(w), prompt: w.prompt?.bind(w) })
  const say = (m) => (typeof m === 'string' ? translateText(m, lang) : m)
  if (orig.confirm) w.confirm = (m) => orig.confirm(say(m))
  if (orig.alert) w.alert = (m) => orig.alert(say(m))
  if (orig.prompt) w.prompt = (m, d) => orig.prompt(say(m), d)
  w.__adalDialogsIn = lang
}

/** Start the language layer. English shows the Amharic pages in English; Amharic and Arabic show the labels in theirs. */
export function startLanguage() {
  const lang = running = getLang()
  const root = document.documentElement
  root.lang = lang
  root.dir = lang === 'ar' ? 'rtl' : 'ltr'
  root.classList.toggle('rtl', lang === 'ar')
  const tree = layer(lang)
  const title = () => { const t = translateText(document.title, lang); if (t !== document.title) document.title = t }
  tree(document.body); title()
  speakDialogs(lang)
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(tree)
      else tree(m.target)
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
}
