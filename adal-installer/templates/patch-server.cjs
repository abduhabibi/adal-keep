const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');
s = s.replace(/import[^\n]*aiIngestion[^\n]*\r?\n/g, "import { startOfflineProcessor } from './src/services/offlineProcessor.js'\n");
s = s.replace(/startFolderWatcher\(/g, 'startOfflineProcessor(');
fs.writeFileSync('server.js', s);
console.log('[PATCH] server.js switched to OFFLINE processor');
