const fs = require('fs');
const path = require('path');

const filePath = path.join(process.cwd(), 'src/routes/files.js');
let content = fs.readFileSync(filePath, 'utf8');

// Fix the download route
content = content.replace(
  /const fullPath = path\.resolve\(file\.path\)/g,
  "const fullPath = path.join(__dirname, '../data/SafeStorage', file.path)"
);

// Also fix the thumbnail route if it exists
content = content.replace(
  /const filePath = path\.resolve\(file\.path\)/g,
  "const filePath = path.join(__dirname, '../data/SafeStorage', file.path)"
);

fs.writeFileSync(filePath, content);
console.log('✅ Routes fixed!');
