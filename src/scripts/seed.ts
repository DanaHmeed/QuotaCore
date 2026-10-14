import "dotenv/config";
import { readFile } from "node:fs/promises";
import { pool } from "../config/database.js";

async function seed() {
  try {
    const sql = await readFile(
      "seeds/001_predefined_plans.sql",
      "utf8"
    );

    await pool.query(sql);

    console.log("Predefined plans seeded successfully");
  } catch (error) {
    console.error("Database seeding failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();