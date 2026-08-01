import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Harmless placeholder so `drizzle-kit generate` works offline; commands
    // that actually touch a database (migrate/studio) need a real DATABASE_URL.
    url:
      process.env.DATABASE_URL ?? "postgres://placeholder:placeholder@localhost:5432/placeholder",
  },
});
