export const REGIONS = [
  { name: 'Addis Ababa', label: 'Sub City', areas: [
    'Addis Ketema','Akaky Kaliti','Arada','Bole','Gullele','Kirkos',
    'Kolfe Keranio','Lideta','Nifas Silk-Lafto','Lemi Kura','Yeka',
  ]},
  { name: 'Dire Dawa', label: 'Sub City', areas: [
    'Dechatu','Biyo Awale','Ganda Gara','Laga Hare','Legehare',
  ]},
  { name: 'Afar', label: 'Zone', areas: [
    'Zone 1','Zone 2','Zone 3','Zone 4','Zone 5',
  ]},
  { name: 'Amhara', label: 'Zone', areas: [
    'Agew Awi','Bahir Dar','Central Gondar','East Gojjam','North Gondar',
    'North Shewa','North Wollo','Oromia Special','South Gondar','South Wollo',
    'Wag Himra','West Armachiho','West Gojjam',
  ]},
  { name: 'Benishangul-Gumuz', label: 'Zone', areas: [
    'Asosa','Kamashi','Metekel','Mao-Komo',
  ]},
  { name: 'South Ethiopia', label: 'Zone', areas: [
    'Ari','Basketo','Bench Sheko','Dawro','Dirashe','Gamo','Gedeo','Gofa',
    'Konso','Konta','Kuraz','Sheka','South Omo','Wolayita','Yem',
  ]},
  { name: 'South West Ethiopia', label: 'Zone', areas: [
    'Bench Sheko','Dawro','Keffa','Konta','Sheka','West Omo',
  ]},
  { name: 'Tigray', label: 'Zone', areas: [
    'Central Tigray','Eastern Tigray','Mekelle','North Western Tigray',
    'Southern Tigray','Western Tigray',
  ]},
]

export const WORK_COUNTRIES = [
  { name: 'Qatar',        currency: 'QAR', salary: 1200 },
  { name: 'Saudi Arabia', currency: 'SAR', salary: 1000 },
  { name: 'Kuwait',       currency: 'KWD', salary: 120  },
  { name: 'Jordan',       currency: 'JOD', salary: 250  },
  { name: 'Dubai',        currency: 'AED', salary: 1200 },
]

export const COUNTRIES_APPLY = [
  { name: 'Saudi Arabia', code: 'SA', currency: 'SAR', salary: 1000 },
  { name: 'Kuwait',       code: 'KW', currency: 'KWD', salary: 120  },
  { name: 'Qatar',        code: 'QA', currency: 'QAR', salary: 1200 },
  { name: 'UAE',          code: 'AE', currency: 'AED', salary: 1200 },
  { name: 'Jordan',       code: 'JO', currency: 'JOD', salary: 250  },
  { name: 'Bahrain',      code: 'BH', currency: 'BHD', salary: 130  },
  { name: 'Oman',         code: 'OM', currency: 'OMR', salary: 130  },
]

export function regionByName(name) {
  return REGIONS.find(r => r.name === name) || null
}
