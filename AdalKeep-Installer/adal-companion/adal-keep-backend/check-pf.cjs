const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./data.sqlite');
db.all("PRAGMA table_info(profile_fields)", (err, cols) => {
  console.log('PROFILE_FIELDS COLS:', cols.map(c => c.name).join(', '));
  db.all("SELECT * FROM profile_fields WHERE profile_id = 5 LIMIT 1", (err, rows) => {
    console.log('SAMPLE ROW (Profile 5):', JSON.stringify(rows[0]));
    db.close();
  });
});
