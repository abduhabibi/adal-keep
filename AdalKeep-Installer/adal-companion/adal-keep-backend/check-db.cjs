const sqlite3 = require('sqlite3');
const fs = require('fs');

const dbPath = fs.existsSync('./data/adal_keep.sqlite') ? './data/adal_keep.sqlite' : './data.sqlite';
console.log("🔍 Inspecting database at:", dbPath);

const db = new sqlite3.Database(dbPath);

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
  if (err) return console.error("DB Error:", err.message);
  
  console.log('\n📋 ALL TABLES:', tables.map(t => t.name).join(', '));
  
  db.all("PRAGMA table_info(profiles)", (err, cols) => {
    if (err) return console.error("Profile Error:", err.message);
    console.log('👤 PROFILES COLUMNS:', cols.map(c => c.name).join(', '));
    
    const docTable = tables.find(t => t.name.includes('document') || t.name.includes('file') || t.name.includes('upload'));
    
    if (docTable) {
      db.all(`PRAGMA table_info(${docTable.name})`, (err, dCols) => {
        console.log(`📁 ${docTable.name.toUpperCase()} COLUMNS:`, dCols.map(c => c.name).join(', '));
        db.close();
      });
    } else {
      console.log('ℹ️ No separate document table found. Files are likely stored in a JSON column or specific fields in profiles/tasks.');
      db.close();
    }
  });
});
