"""Development entry point: `python run.py` (reads backend/.env.dev).

Production: run behind a WSGI server, e.g. `gunicorn -w 2 'app:create_app()'`.
"""
import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "5000")), debug=False)
