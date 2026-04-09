import asyncio
import logging
from supabase_client import seed_questions_db
from database import ANSWER_BANK

logging.basicConfig(level=logging.INFO)

async def main():
    print("Seeding local answer bank to Supabase...")
    await seed_questions_db(ANSWER_BANK)
    print("Done.")

if __name__ == "__main__":
    asyncio.run(main())
