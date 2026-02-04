const mysql = require("mysql2/promise");
require("dotenv").config();

const url = process.env.DATABASE_URL || process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL;

if (!url) {
  console.error("❌ DB URL is missing. Set DATABASE_URL (or MYSQL_PUBLIC_URL/MYSQL_URL) in Render env.");
} else {
  console.log("✅ DB URL is set (length):", url.length);
}

const pool = url
  ? mysql.createPool(url)
  : mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });

module.exports = pool;
