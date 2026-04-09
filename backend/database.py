"""
Mock database of interview questions and expected/scripted answers.
Used as the reference bank for semantic similarity comparison.
"""

ANSWER_BANK = [
    {
        "question": "Tell me about yourself.",
        "answer": (
            "I am a software engineer with five years of experience building scalable web applications. "
            "I specialize in Python and JavaScript, and I have led teams of up to eight developers. "
            "I am passionate about clean code, system design, and continuously learning new technologies. "
            "In my previous role I architected a microservices platform that reduced deployment time by forty percent."
        ),
        "category": "introduction",
    },
    {
        "question": "What is object-oriented programming?",
        "answer": (
            "Object-oriented programming is a programming paradigm based on the concept of objects, "
            "which contain data in the form of fields and code in the form of methods. "
            "The four main principles are encapsulation, inheritance, polymorphism, and abstraction. "
            "OOP helps organize complex code into reusable, maintainable units and models real-world entities naturally."
        ),
        "category": "technical",
    },
    {
        "question": "Explain REST APIs.",
        "answer": (
            "REST stands for Representational State Transfer. It is an architectural style for designing "
            "networked applications using HTTP requests. REST APIs use standard HTTP methods such as GET, "
            "POST, PUT, and DELETE. Data is typically exchanged in JSON format. REST APIs are stateless, "
            "meaning each request contains all information needed to process it without relying on server-side sessions."
        ),
        "category": "technical",
    },
    {
        "question": "What is recursion?",
        "answer": (
            "Recursion is a programming technique where a function calls itself to solve a problem by breaking "
            "it down into smaller subproblems. Every recursive function must have a base case to stop the "
            "recursion and a recursive case that moves closer to the base case. "
            "Classic examples include computing factorials, Fibonacci sequences, and traversing tree data structures."
        ),
        "category": "technical",
    },
    {
        "question": "Describe your problem-solving approach.",
        "answer": (
            "When faced with a problem, I first take time to fully understand the requirements and constraints. "
            "Then I break the problem into smaller parts and consider multiple approaches before selecting "
            "the most efficient solution. I write clean, well-documented code and test thoroughly. "
            "If I get stuck, I consult documentation, leverage debugging tools, or collaborate with colleagues."
        ),
        "category": "behavioral",
    },
    {
        "question": "What are your strengths and weaknesses?",
        "answer": (
            "My greatest strength is my ability to learn quickly and adapt to new technologies and environments. "
            "I am also highly organized and consistently meet deadlines under pressure. "
            "My weakness is that I sometimes focus too much on perfecting details, "
            "though I have learned to balance quality with delivery timelines by setting strict time-boxes."
        ),
        "category": "behavioral",
    },
    {
        "question": "Why do you want to work here?",
        "answer": (
            "I am drawn to your company because of its reputation for innovation and strong engineering culture. "
            "The projects align perfectly with my background in distributed systems and machine learning. "
            "I believe I can contribute meaningfully to the team while continuing to grow professionally "
            "in an environment that values technical excellence and collaboration."
        ),
        "category": "behavioral",
    },
    {
        "question": "What is a database index and why is it important?",
        "answer": (
            "A database index is a data structure that improves the speed of data retrieval operations on a "
            "database table at the cost of additional storage space and slower write operations. "
            "Indexes work similarly to a book index, pointing to the location of data without scanning every row. "
            "They are critical for query performance on large datasets and are commonly created on frequently "
            "searched columns or foreign keys."
        ),
        "category": "technical",
    },
]
