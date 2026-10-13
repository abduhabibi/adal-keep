const sqlite3 = require('sqlite3');
const fs = require('fs');

// Find all sqlite files in the backend folder
const allFiles = fs.readdirSync('.').filter(f => f.endsWith('.sqlite'));
const dataFiles = fs.existsSync('./data') ? fs.readdirSync('./data').filter(f => f.endsWith('.sqlite')).map(f => './data/' + f) : [];
const targets = [...new Set([...allFiles, ...dataFiles])];

console.log("🔍 Found DB files:", targets);

targets.forEach(dbPath => {
  console.log(`\n--- Inspecting ${dbPath} ---`);
  const db = new sqlite3.Database(dbPath);
  db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) return console.error("Error:", err.message);
    if (!tables || tables.length === 0) {
      console.log("❌ Empty database.");
      db.close();
      return;
    }
    console.log('📋 Tables:', tables.map(t => t.name).join(', '));
    
    // Inspect profiles if it exists
    if (tables.find(t => t.name === 'profiles')) {
      db.all("PRAGMA table_info(profiles)", (err, cols) => {
        console.log('👤 Profiles Cols:', cols.map(c => c.name).join(', '));
        db.close();
      });
    } else {
      db.close();
    }
  });
});
