import fs from 'fs'
const p = 'src/services/deepseekVision.js'
let s = fs.readFileSync(p, 'utf8')

if (s.includes('SLIP_HANDLING_MARKER')) { console.log('already patched'); process.exit(0) }

// Extend the schema block
s = s.replace(
  /"date_of_birth":\s*"",[\s\S]*?"medical_result":\s*"",/,
  `"date_of_birth":   "",
    "date_of_issue":   "",
    "date_of_expiry":  "",
    "place_of_birth":  "",
    "sex":             "M or F",
    "nationality":     "",
    "middle_name":     "",   // second given name (father's name in Ethiopian convention)
    "employee_name":   "",
    "employer_name":   "",
    "contract_number": "",
    "visa_number":     "",
    "medical_result":  "",
    // SLIP_HANDLING_MARKER — only for bank/payment slips
    "reference_name":  "",   // the WORKER this payment is for — used to match the profile
    "customer_name":   "",   // who paid — the sponsor/payer, NOT the profile
    "order_id":        "",`
)

// Add Slip classification rules
s = s.replace(
  /- other: unclear, unreadable, or none of the above\./,
  `- Slip: bank/payment receipt, transaction slip, money transfer confirmation.
  If the document shows "Order ID", "Transaction Status", "Reference",
  "Debit Account", "Credit Account", or "SWIFT/Bank name" it is a Slip.
  For a Slip you MUST extract:
    reference_name = the value next to "Reference" (the WORKER — this is the
      profile this slip belongs to, use it as full_name)
    customer_name  = the value next to "Customer Name" (the payer — NOT the worker)
    order_id       = the value next to "Order ID"
  If reference_name is empty, fall back to customer_name.
- other: unclear, unreadable, or none of the above.`
)

// Emphasize reference_name usage as full_name
s = s.replace(
  /- Never invent a name\. If unreadable, set to null\./,
  `- Never invent a name. If unreadable, set to null.
- Slips: full_name MUST equal reference_name, NOT customer_name.
- Names with 3 parts: first_name = first word, middle_name = middle word,
  last_name = last word. Example "MIHRET TUMISO DEBOCH" →
  first_name="MIHRET", middle_name="TUMISO", last_name="DEBOCH".`
)

fs.writeFileSync(p, s)
console.log('✓ vision prompt updated for slips')
