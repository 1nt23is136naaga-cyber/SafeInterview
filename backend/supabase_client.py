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
