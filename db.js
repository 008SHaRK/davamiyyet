const mysql = require("mysql2/promise");
require("dotenv").config();

const url = process.env.DATABASE_URL || process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL;

if (!url) {
  throw new Error("DATABASE_URL (or MYSQL_PUBLIC_URL/MYSQL_URL) is not set");
}

const pool = mysql.createPool(url);

module.exports = pool;
