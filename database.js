const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(':memory:'); // Para produção, use um arquivo de banco de dados persistente

db.serialize(() => {
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, email TEXT, password TEXT)");
  db.run("CREATE TABLE prompts (id INTEGER PRIMARY KEY, user_id INTEGER, prompt TEXT, FOREIGN KEY(user_id) REFERENCES users(id))");
});

module.exports = db;
