import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTemplateText } from '../src/services/musanedContracts.js'

// The English side of Musaned's template.pdf as pdf-parse reads it (the Arabic
// half follows a tab). Every name and number here is made up.
const TEXT = [
  'CONTRACT # 1000000001', 'VISA NUMBER # 2000000002',
  'corresponding to (05/01/2026), by and',
  'A. Employer: \t:ﻞﻤﻌﻟا ﺐﺣﺎﺻ',
  'Name: SAMPLE EMPLOYER FULL NAME \tﻢﺳﻻا',
  'National ID Number: 1000000000 \t1000000000',
  'City: Riyadh \tضﺎﻳﺮﻟا', 'Mobile: 966500000000 \tx', 'Telephone: 0500000000 \tx',
  'Arabia by Saudi Recruiting Agency:',
  'Name: Sample Saudi', 'Recruitment Office', 'ﺐﺘﻜﻣ :ﻢﺳﻻا',
  'License no: 1234567 \tx', 'Telephone: +966500000001 \tx', 'City: Jeddah \tx', 'Email: office@example.com \t:ﻲﻧوﺮﺘﻜﻟﻹا',
  'B. Domestic Service Worker: \tx', 'Name: SAMPLE WORKER NAME \tx',
  'his\\her country by Recruitment Agency:', 'Name: SAMPLE FOREIGN EMPLOYMENT', 'AGENCY', 'License No: 999', 'Address',
  'The employer and the DSW hereby',
].join('\n')

test('template.pdf: employer, Saudi agency, our agency, contract', () => {
  const t = parseTemplateText(TEXT)
  assert.equal(t.contractNumber, '1000000001')
  assert.equal(t.visaNumber, '2000000002')
  assert.equal(t.contractDate, '2026-01-05')
  assert.deepEqual(t.employer, { name: 'SAMPLE EMPLOYER FULL NAME', id: '1000000000', city: 'Riyadh', mobile: '966500000000', telephone: '0500000000' })
  assert.equal(t.saudiAgency.name, 'Sample Saudi Recruitment Office')
  assert.equal(t.saudiAgency.license, '1234567')
  assert.equal(t.saudiAgency.email, 'office@example.com')
  assert.equal(t.ourAgency.name, 'SAMPLE FOREIGN EMPLOYMENT AGENCY')
  assert.equal(t.ourAgency.license, '999')
})
