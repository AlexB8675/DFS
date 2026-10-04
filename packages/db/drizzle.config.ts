import { defineConfig } from 'drizzle-kit'

// drizzle-kit only generates migrations from the schema; `src/migrate.ts`
// applies them, so neither development nor production needs drizzle-kit to run.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
})
