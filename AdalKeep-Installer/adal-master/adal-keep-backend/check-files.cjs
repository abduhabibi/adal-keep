const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./data/adal_keep.sqlite');
db.all("PRAGMA table_info(files)", (err, cols) => {
  if (err) return console.error(err);
  console.log('📁 FILES COLUMNS:', cols.map(c => c.name).join(', '));
  db.close();
});
