import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
import sys

# Add the 'api' directory to the system path to allow clean imports
sys.path.append(os.path.join(os.path.dirname(__file__), 'api'))

sys.stdout.reconfigure(encoding='utf-8') 
sys.stderr.reconfigure(encoding='utf-8')

from api.router import api_router # Import the API router we just created
from api.firebase_setup import initialize_firebase # <-- Import the Firebase initialization function

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
    This runs once before the server accepts any requests.
    """
    print("Application Startup: Initializing Firebase...")
    initialize_firebase()
# -----------------------------------------------------------------

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