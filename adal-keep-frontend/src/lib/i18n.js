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
  // a few phrases written with other spellings / forms on the pages
  'የተመደቡ ፕሮፋይሎች ': 'Assigned profiles ',
  'ፕሪሚየም CRM': 'Premium CRM',
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

/** Start the English layer (does nothing in Amharic). */
export function startLanguage() {
  if (getLang() !== 'en') return
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
