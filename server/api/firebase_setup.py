import firebase_admin
from firebase_admin import credentials, firestore
import os
import traceback

# --- Configuration Constants ---
# Path to the service account key file (DANGER: DO NOT COMMIT THIS FILE!)
# You must download this JSON file from your Google Firebase Project settings.
DEFAULT_SERVICE_ACCOUNT_KEY_PATH = os.path.join(os.path.dirname(__file__), 'firebase-admin-key.json')
# Allow overriding the path via environment variable for flexibility in different environments
SERVICE_ACCOUNT_KEY_PATH = os.environ.get('FIREBASE_ADMIN_KEY_PATH', DEFAULT_SERVICE_ACCOUNT_KEY_PATH)

# --- Global Database References ---
db = None

def initialize_firebase():
    """Initializes the Firebase Admin SDK and sets up the Firestore client."""
    global db
    
    # First, allow passing raw credentials via env var (useful for CI or containerized deployments)
    print(f"Firebase setup: using key path: {SERVICE_ACCOUNT_KEY_PATH}")
    raw_creds = os.environ.get('FIREBASE_ADMIN_CREDENTIALS')
    if raw_creds:
        try:
            import json
            cred_dict = json.loads(raw_creds)
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred)
            db = firestore.client()
            print("Firebase Admin SDK and Firestore initialized from FIREBASE_ADMIN_CREDENTIALS env var.")
            return
        except Exception as e:
            print(f"ERROR: Failed to initialize Firebase from FIREBASE_ADMIN_CREDENTIALS: {e}")
            traceback.print_exc()

    # Next, check for a service account JSON file at the configured path
    if not os.path.exists(SERVICE_ACCOUNT_KEY_PATH):
        print("="*80)
        print("ERROR: FIREBASE ADMIN KEY NOT FOUND.")
        print(f"Please place your service account JSON file at: {SERVICE_ACCOUNT_KEY_PATH}")
        print("Alternatively, set the environment variable FIREBASE_ADMIN_CREDENTIALS with the JSON contents.")
        print("Database functionality will be disabled until this is resolved.")
        print("="*80)
        # We can stop initialization here, but we will proceed with a None db handle
        # so the server can still start for other network testing.
        return
    try:
        # Load credentials from the specified JSON file
        cred = credentials.Certificate(SERVICE_ACCOUNT_KEY_PATH)

        # Initialize the Firebase app (project ID is usually inferred from the key file)
        try:
            # If the default app already exists, get_app() will succeed; otherwise it raises
            firebase_admin.get_app()
            print("Firebase app already initialized; reusing existing app.")
        except Exception:
            # Not initialized yet — initialize with provided credentials
            firebase_admin.initialize_app(cred)

        # Get a reference to the Firestore client
        db = firestore.client()
        print("Firebase Admin SDK and Firestore successfully initialized from key file.")

    except Exception as e:
        print(f"FATAL ERROR initializing Firebase: {e}")
        traceback.print_exc()
        db = None # Ensure db is None if initialization failed

def get_firestore_client():
    """Returns the initialized Firestore client."""
    # Ensure initialization happens only once
    if db is None:
        initialize_firebase()
        
    return db