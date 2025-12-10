import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
import sys
from dotenv import load_dotenv

# Load environment variables from .env file in the server directory
env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(env_path)

# When running `python main.py` from the `server/` directory, Python's import
# machinery doesn't include the repository root on `sys.path`, so package-style
# imports like `server.api...` fail locally. Ensure the parent directory (project
# root) is on `sys.path` so the same imports work both locally and on the host.
if __package__ is None:
    repo_root = os.path.dirname(os.path.dirname(__file__))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

# Use package imports instead of manipulating sys.path

sys.stdout.reconfigure(encoding='utf-8') 
sys.stderr.reconfigure(encoding='utf-8')

from server.api.router import api_router # Import the API router we just created
from server.api.firebase_setup import initialize_firebase # <-- Import the Firebase initialization function
from server.queue_worker import queue_worker  # Import queue worker

# --- FASTAPI APPLICATION INITIALIZATION ---

app = FastAPI(
    title="Web Interview Recorder API",
    description="Backend for handling video uploads, network reliability, and AI analysis.",
    version="1.0.0"
)

# --- CORS CONFIGURATION (Crucial for Network Communication) ---
# Allows the frontend (client) to access the backend (server) from a different port or domain.
# In development, the client typically runs on localhost:3000/5173 and the server on localhost:8000.
origins = [
    # Allow requests from the frontend during local development
    "https://web-interview-recorder.vercel.app/", 
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5173", # Common React/Vite development port
    "*", # TEMP: Allow all origins during initial development phase
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"], # Allow all HTTP methods (GET, POST, etc.)
    allow_headers=["*"], # Allow all headers
)

# --- LIFECYCLE HOOK (Database Initialization) ---
@app.on_event("startup")
async def startup_event():
    """
    Initializes Firebase and the database client when the server starts.
    Also starts the background queue worker.
    """
    print("Application Startup: Initializing Firebase...")
    initialize_firebase()
    
    print("Application Startup: Starting queue worker...")
    queue_worker.start()

@app.on_event("shutdown")
async def shutdown_event():
    """
    Stops the queue worker when the server shuts down.
    """
    print("Application Shutdown: Stopping queue worker...")
    queue_worker.stop()

# --- API ROUTER INCLUSION ---

app.include_router(api_router)

# Serve uploaded files (video + transcripts) from the `server/uploads` folder
uploads_path = os.path.join(os.path.dirname(__file__), 'uploads')
os.makedirs(uploads_path, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=uploads_path), name="uploads")

# --- HEALTH CHECK ENDPOINT ---

@app.get("/", tags=["Root"])
async def read_root():
    """Root endpoint to verify server status."""
    return {"message": "Web Interview Recorder API is running! Check /api/status"}

# --- SERVER STARTUP ---

if __name__ == "__main__":
    # Ensure the 'uploads' directory for temporary storage exists (will be used later)
    os.makedirs("uploads", exist_ok=True)
    
    # Run the Uvicorn server on port 8000
    uvicorn.run(app, host="0.0.0.0", port=8000)