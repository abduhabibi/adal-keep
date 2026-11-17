/**
 * Language: Amharic (as written in the pages) or English.
 *
 * English is a layer over the pages: while it is on, every known Amharic
 * phrase on screen (text, placeholders, titles) is shown in English. Only
 * whole phrases are replaced, never parts of words, and nothing inside
 * [translate="no"] (chat messages, people's data) is touched. Choosing
 * Amharic again reloads the page as written. Saved per PC.
 */
const KEY = 'adal-lang'

export function getLang() {
  try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'am' } catch { return 'am' }
}

export function setLang(lang) {
  try { localStorage.setItem(KEY, lang === 'en' ? 'en' : 'am') } catch {}
  window.location.reload()
}

const EN = {
  'ካቆሙበት ይቀጥሉ': 'Continue where you left off',
  'ለመስራት ተግባሮች': 'Tasks to do',
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
function translateTree(root) {
  if (skip(root)) return
  if (root.nodeType === 3) {
    const t = tr(root.nodeValue)
    if (t !== root.nodeValue) root.nodeValue = t
    return
  }
  if (root.nodeType !== 1) return
  for (const a of ['placeholder', 'title', 'aria-label']) {
    const v = root.getAttribute?.(a)
    if (v && ETHIOPIC.test(v)) { const t = tr(v); if (t !== v) root.setAttribute(a, t) }
  }
  if (root.tagName === 'OPTION' || root.tagName === 'BUTTON' || root.childNodes.length) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if (n.closest('[translate="no"], script, style, textarea')) continue
        for (const a of ['placeholder', 'title', 'aria-label']) {
          const v = n.getAttribute(a)
          if (v && ETHIOPIC.test(v)) { const t = tr(v); if (t !== v) n.setAttribute(a, t) }
        }
      } else if (ETHIOPIC.test(n.nodeValue) && !skip(n)) {
        const t = tr(n.nodeValue)
        if (t !== n.nodeValue) n.nodeValue = t
      }
    }
  }
}

/**
 * Amharic for the labels that were written in English. Only a whole label
 * (a text, placeholder or title that is exactly one of these) is replaced, so
 * names and other data are never touched, and nothing inside [translate="no"].
 */
const AM = {
  // Profiles
  'Wakala': 'ዋካላ', '✓ Paid': '✓ ተከፍሏል', '⏳ Unpaid': '⏳ አልተከፈለም', 'Musaned': 'ሙሳነድ', 'Selected': 'ተመርጧል',
  'Wafid': 'ዋፊድ', 'Insurance': 'ኢንሹራንስ', 'Embassy': 'ኤምባሲ', 'Visa': 'ቪዛ', 'Arrived': 'ደርሳለች',
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
  'All generated CVs': 'ሁሉም የተዘጋጁ ሲቪዎች', 'Templates': 'ቅጦች', '📥 Add from Musaned': '📥 ከሙሳነድ አክል', '+ New CV': '+ አዲስ ሲቪ',
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
  'Agency Email (for Musaned/Notifications)': 'የኤጀንሲ ኢሜይል (ለሙሳነድ/ማሳወቂያዎች)', 'Save Settings': 'ቅንብሮችን አስቀምጥ',
  'PC number': 'የኮምፒውተር ቁጥር', 'Software Updates': 'የሶፍትዌር ማሻሻያዎች', 'Update by itself': 'ራሱ ይዘምን',
  'Check GitHub for the latest version and install it': 'አዲሱን ስሪት ፈልገው ይጫኑ', 'Check for Updates': 'ማሻሻያ ፈልግ',
  'This email will be used as the default contact for automated workflows like Musaned.': 'ይህ ኢሜይል እንደ ሙሳነድ ላሉ ራስ-ሰር ሥራዎች ዋና መገናኛ ሆኖ ያገለግላል።',
  '— a new version installs as soon as no automation run is working (checked every 15 minutes)': '— ምንም ሮቦት በማይሠራበት ጊዜ አዲስ ስሪት ራሱ ይጫናል (በየ15 ደቂቃው ይፈተሻል)',
  'Click New CV to pick a candidate and generate a formatted CV for one of your agencies.': '«አዲስ ሲቪ»ን ይጫኑ፤ ዕጩ ይምረጡና ለአንዱ ኤጀንሲዎ የተዘጋጀ ሲቪ ያውጡ።',
  'No new documents today. Save a passport, slip or photo into Downloads and it shows up here within a few seconds.': 'ዛሬ አዲስ ሰነድ የለም። ፓስፖርት፣ ስሊፕ ወይም ፎቶ ወደ Downloads ያስቀምጡ፤ በጥቂት ሰከንዶች ውስጥ እዚህ ይታያል።',
  'No templates yet': 'ገና ቅጥ የለም', 'Click New Template to create your first agency layout.': 'የመጀመሪያውን የኤጀንሲ ቅጥ ለመፍጠር «ቅጥ ፍጠር»ን ይጫኑ።',
  'Not available in the demo': 'በማሳያው ላይ አይገኝም',
  'Light': 'ብሩህ', 'Dark': 'ጨለማ', 'Gradient': 'ቅልመት', 'No wallpaper': 'የግድግዳ ምስል የለም', 'Upload wallpaper': 'የግድግዳ ምስል ስቀል',
}
const LATIN = /[A-Za-z]/
function trAm(text) {
  if (!text || !LATIN.test(text)) return text
  const t = text.trim()
  const hit = AM[t]
  return hit ? text.replace(t, hit) : text
}
function amharicTree(root) {
  const one = (el) => {
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute?.(a)
      if (v && LATIN.test(v)) { const t = trAm(v); if (t !== v) el.setAttribute(a, t) }
    }
  }
  if (root.nodeType === 3) {
    if (!skip(root)) { const t = trAm(root.nodeValue); if (t !== root.nodeValue) root.nodeValue = t }
    return
  }
  if (root.nodeType !== 1 || skip(root)) return
  one(root)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) { if (!n.closest('[translate="no"], script, style, textarea')) one(n) }
    else if (LATIN.test(n.nodeValue) && !skip(n)) { const t = trAm(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t }
  }
}
function startAmharic() {
  document.documentElement.lang = 'am'
  amharicTree(document.body)
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(amharicTree)
      else amharicTree(m.target)
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] })
}

/** Start the language layer: English over the Amharic pages, or Amharic for the English labels. */
export function startLanguage() {
  if (getLang() !== 'en') return startAmharic()
  document.documentElement.lang = 'en'
  const titleOnce = () => { const t = tr(document.title); if (t !== document.title) document.title = t }
  const run = () => { translateTree(document.body); titleOnce() }
  run()
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') translateTree(m.target)
      else if (m.type === 'attributes') translateTree(m.target)
      else m.addedNodes.forEach(translateTree)
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] })
}
