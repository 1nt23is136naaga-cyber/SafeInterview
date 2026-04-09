import os
import fitz  # PyMuPDF
import json
import logging
import re
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

async def parse_resume_to_text(pdf_bytes: bytes) -> str:
    """Extract text from PDF bytes using PyMuPDF."""
    text = ""
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        for page in doc:
            text += page.get_text() + "\n"
        doc.close()
    except Exception as e:
        logger.error(f"Failed to parse PDF: {e}")
        raise ValueError("Invalid PDF format or corrupted file.")
    return text.strip()


async def generate_questions(resume_text: str) -> list[str]:
    """Generate 3 technical verification questions based on the resume text."""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    
    # ── KEYWORD HEURISTIC MOCK (if no LLM) ──
    if not api_key:
        logger.warning("OPENAI_API_KEY not set — using weighted keyword heuristic for resume.")
        
        # Categorized pool of questions
        pool = {
            "frontend": {
                "keywords": ["react", "vue", "angular", "javascript", "typescript", "css", "html", "frontend", "nextjs", "tailwind"],
                "q": "Your resume suggests frontend expertise. Can you explain how you manage complex application state and what criteria you use to choose between different framework-specific state management tools?"
            },
            "backend": {
                "keywords": ["python", "nodejs", "express", "fastapi", "django", "flask", "backend", "api", "rest", "graphql", "microservices"],
                "q": "I see backend expertise on your resume. How do you design your database schemas to ensure scalability and how do you approach API versioning in a production environment?"
            },
            "database": {
                "keywords": ["sql", "postgres", "mongodb", "database", "mysql", "nosql", "query", "orm", "redis", "elasticsearch"],
                "q": "Regarding your database experience, describe a complex query or indexing challenge you faced and how you optimized it for performance."
            },
            "cloud_devops": {
                "keywords": ["aws", "azure", "gcp", "docker", "kubernetes", "cloud", "devops", "terraform", "ansible", "jenkins", "cicd"],
                "q": "You listed cloud/DevOps experience. How do you approach automated deployment pipelines to ensure zero-downtime releases in a production environment?"
            },
            "security": {
                "keywords": ["security", "auth", "jwt", "encryption", "penetration", "cyber", "oauth", "iam"],
                "q": "Your experience includes security. What are the top three vulnerabilities you always check for during a code review, and how do you mitigate them?"
            },
            "mobile": {
                "keywords": ["react native", "flutter", "swift", "kotlin", "android", "ios", "mobile", "dart"],
                "q": "Your resume mentions mobile development. How do you handle platform-specific UI/UX differences while maintaining a single codebase or consistent user experience?"
            },
            "data_science": {
                "keywords": ["data", "machine learning", "ai", "spark", "pandas", "numpy", "tensorflow", "pytorch", "scikit", "nlp", "tableau"],
                "q": "I see data science or machine leaning on your resume. How do you typically handle missing data or outliers in your datasets and what impact does that have on your model's reliability?"
            },
            "testing_qa": {
                "keywords": ["testing", "qa", "selenium", "cypress", "jest", "unit test", "automation", "mocha", "playwright"],
                "q": "You mentioned testing or QA. Describe your strategy for end-to-end testing and how you ensure that test suites remain fast and reliable as the application grows."
            },
            "management": {
                "keywords": ["management", "lead", "agile", "scrum", "project", "jira", "manager", "architect", "strategy"],
                "q": "Regarding your leadership experience, how do you manage technical debt and balance the need for new features with maintaining code quality and system stability?"
            }
        }

        resume_lower = resume_text.lower()
        category_scores = []
        
        for category_name, content in pool.items():
            # count occurrences for weighting
            score = sum(resume_lower.count(kw) for kw in content["keywords"])
            if score > 0:
                category_scores.append((score, content["q"]))
        
        # Sort by score (descending)
        category_scores.sort(key=lambda x: x[0], reverse=True)
        
        found_questions = [q for score, q in category_scores]
        
        # Fillers if not enough keywords found
        fillers = [
            "Can you describe the most technically complex feature you reported on your resume and your specific role in its implementation?",
            "How do you keep up with the latest tech trends and decide which new tools or frameworks are worth adopting for your projects?",
            "Explain a scenario where you had to debug a critical production issue related to one of the projects mentioned on your resume."
        ]
        
        final_questions = (found_questions + fillers)[:3]
        return final_questions

    # ── LLM GENERATION (if API key exists) ──
    model = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo")
    client = AsyncOpenAI(api_key=api_key)

    system_prompt = """You are an expert technical recruiter. You will be provided with a candidate's separated resume text.
Extract their core skills, past projects, or notable accomplishments.
Generate exactly 3 deep, challenging, and specific interview questions based ONLY on what is claimed in the resume to verify if their knowledge is genuine or exaggerated.
Format your response as a valid JSON array of strings. Do not include any other markdown or text."""

    user_prompt = f"Resume Text:\n\n{resume_text[:4000]}" # Limit to first 4000 characters to save tokens

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=300,
        )
        raw = response.choices[0].message.content.strip()
        # Find JSON array
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if match:
            questions = json.loads(match.group())
            return questions[:3]
        raise ValueError("Response was not a valid JSON array.")
    except Exception as exc:
        logger.error("Failed to generate resume questions: %s", exc)
        return [
            "Can you elaborate on the most complex technical challenge listed on your resume and how you overcame it?",
            "What specific role did you play in the architecture of the primary project listed on your resume?",
            "How did you measure the success of the tools and frameworks you reported proficiency in?"
        ]


async def evaluate_resume_answer(transcript: str, question: str, resume_text: str) -> dict:
    """Evaluate if the verbal answer shows genuine knowledge or fake/exaggerated claims based on the resume."""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        logger.warning("OPENAI_API_KEY not set — using mock evaluation for resume answer.")
        word_count = len(transcript.split())
        if word_count > 50:
            return {
                "legitimacy_score": 0.85, 
                "verdict": "Legit", 
                "explanation": "The candidate provided a detailed response that appears to back up their claims."
            }
        else:
            return {
                "legitimacy_score": 0.35, 
                "verdict": "Fake/Exaggerated", 
                "explanation": "The candidate's response was too brief and lacked the technical depth expected from their resume."
            }

    model = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo")
    client = AsyncOpenAI(api_key=api_key)

    system_prompt = """You are a senior technical evaluator. 
You will receive:
1. The text of a candidate's resume.
2. An interview question based on that resume.
3. The candidate's real-time spoken answer (transcript).

Your task: Evaluate if the candidate actually possesses the knowledge they claim on their resume, or if the data appears fake, memorized buzzwords, or highly exaggerated.
Return ONLY valid JSON in this exact format:
{"legitimacy_score": <float 0.0-1.0>, "verdict": "<Legit | Fake/Exaggerated>", "explanation": "<short sentence explaining why>"}

A score near 1.0 means the candidate perfectly backed up their resume claims with deep, contextual knowledge.
A score near 0.0 means the candidate gave a generic, shallow, or wildly incorrect answer that contradicts their resume claims."""

    user_prompt = f"""Resume Snippet Context:
{resume_text[:2000]}

Question Asked: {question}

Candidate's Answer:
"{transcript}"
"""

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            max_tokens=200,
        )
        raw = response.choices[0].message.content.strip()
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            data = json.loads(match.group())
            return {
                "legitimacy_score": round(float(data.get("legitimacy_score", 0.5)), 4),
                "verdict": data.get("verdict", "Unknown"),
                "explanation": data.get("explanation", "Could not parse explanation.")
            }
        raise ValueError("Invalid JSON format from LLM.")
    except Exception as exc:
        logger.error("Failed to evaluate resume answer: %s", exc)
        return {
                "legitimacy_score": 0.5, 
                "verdict": "Unknown", 
                "explanation": "LLM evaluation failed to process the answer."
        }
