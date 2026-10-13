const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

// Check both possible database locations
let dbPath = './data/adal_keep.sqlite';
if (!fs.existsSync(dbPath)) dbPath = './data.sqlite';

console.log("🔍 Inspecting database at:", path.resolve(dbPath));

const db = new sqlite3.Database(dbPath);

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
  if (err) { console.error("DB Error:", err); return; }
  
  console.log("\n=== FOUND TABLES ===");
  tables.forEach(t => console.log("-", t.name));

  let count = 0;
  tables.forEach(table => {
    db.all(`PRAGMA table_info(${table.name})`, (err, cols) => {
      console.log(`\n[Table: ${table.name}]`);
      cols.forEach(c => console.log(`  - ${c.name} : ${c.type}`));
      count++;
      if (count === tables.length) {
        console.log("\n✅ Inspection complete.");
        db.close();
      }
    });
  });
});
