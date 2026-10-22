const prisma = require('../src/lib/prisma');

async function dropAll() {
  try {
    await prisma.$connect();
    console.log('🔗 Connected to database');

    const drop = async (sql, msg) => {
      await prisma.$executeRawUnsafe(sql);
      console.log(msg);
    };

    await drop(
      `DO $$ DECLARE r RECORD;
       BEGIN
         FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
           EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
         END LOOP;
         FOR r IN (
           SELECT t.typname
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typtype = 'e'
         ) LOOP
           EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
         END LOOP;
       END $$;`,
      '🗑️ Dropped all public tables and enum types'
    );

    console.log('✅ All tables and enums dropped successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

dropAll();
