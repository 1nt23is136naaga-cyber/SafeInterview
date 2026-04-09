import os
import logging
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

URL: str = os.getenv("SUPABASE_URL")
KEY: str = os.getenv("SUPABASE_KEY")

supabase: Client = None

if URL and KEY:
    try:
        supabase = create_client(URL, KEY)
        logger.info("Supabase client initialized.")
    except Exception as e:
        logger.error(f"Failed to initialize Supabase client: {e}")
else:
    logger.warning("Supabase credentials missing. Persistent storage will be disabled.")

async def save_session_db(session_id: str, data: dict):
    """Upsert session data into Supabase 'interviews' table."""
    if not supabase:
        return
    try:
        # We use session_id as the primary key
        # Ensure the table 'interviews' exists with a primary key column 'session_id'
        data["session_id"] = session_id
        response = supabase.table("interviews").upsert(data).execute()
        return response
    except Exception as e:
        logger.error(f"Error saving session to Supabase: {e}")

async def load_sessions_db():
    """Load all sessions from Supabase 'interviews' table."""
    if not supabase:
        return {}
    try:
        response = supabase.table("interviews").select("*").execute()
        sessions = {item["session_id"]: item for item in response.data}
        return sessions
    except Exception as e:
        logger.error(f"Error loading sessions from Supabase: {e}")
        return {}

async def get_questions_db():
    """Fetch all interview questions from Supabase 'questions' table."""
    if not supabase:
        from database import ANSWER_BANK
        return ANSWER_BANK
    try:
        response = supabase.table("questions").select("*").execute()
        if response.data:
            return response.data
        else:
            from database import ANSWER_BANK
            return ANSWER_BANK
    except Exception as e:
        logger.error(f"Error fetching questions from Supabase: {e}")
        from database import ANSWER_BANK
        return ANSWER_BANK

async def seed_questions_db(questions: list):
    """Batch insert questions into Supabase."""
    if not supabase:
        return
    try:
        # Filter for required columns
        formatted = []
        for q in questions:
            formatted.append({
                "question": q["question"],
                "answer": q["answer"],
                "category": q.get("category", "technical")
            })
        response = supabase.table("questions").upsert(formatted, on_conflict="question").execute()
        logger.info(f"Seeded {len(formatted)} questions to Supabase.")
        return response
    except Exception as e:
        logger.error(f"Error seeding questions: {e}")

