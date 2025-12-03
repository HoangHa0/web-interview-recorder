import React, { useState, useEffect, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, collection, getDocs, setDoc, getDoc, query, where, setLogLevel } from 'firebase/firestore';
import QUESTIONS from './questionBank';

// IMPORTANT: Global variables provided by the Canvas environment for Firebase setup
// TEMPORARY: Hardcode actual Firebase config for local testing
const firebaseConfig = {
  apiKey: "AIzaSyBF64HOMIFsqbAkwTQp2rpehUcOfLrZEUo",
  authDomain: "web-interview-recorder.firebaseapp.com",
  projectId: "web-interview-recorder",
  storageBucket: "web-interview-recorder.firebasestorage.app",
  messagingSenderId: "727320435280",
  appId: "1:727320435280:web:3872dfcaa03debab4f4f55",
  measurementId: "G-9P3JJP1VM6"
}; 
// const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Define the API Base URL (must match the FastAPI server)
// Use Vite environment variable `VITE_API_BASE_URL` in production (e.g. Vercel),
// otherwise fall back to local development server.
const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
    ? import.meta.env.VITE_API_BASE_URL
    : 'http://127.0.0.1:8000/api';

// Hardcoded Admin Key for Interviewer login simulation (Replace with database lookup later)
const ADMIN_AUTH_KEY = "VUNGOIMORA12345"; 

// Mandatory constraint
const MAX_QUESTIONS = 5; 
const MAX_RETRIES = 3; // Maximum number of automatic retry attempts
const BASE_DELAY_MS = 2000; // 2 second initial delay for exponential backoff

// Set Firestore log level to debug for better development feedback
setLogLevel('debug');

/**
 * Helper function to format seconds into MM:SS string.
 */
const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(minutes)}:${pad(remainingSeconds)}`;
};

/**
 * Volume Meter with Fill Effect
 * @param {number} audioLevel - Current volume level (0-100)
 * @param {boolean} isRecording - If currently recording, changes color
 */
const VolumeMeter = React.memo(({ audioLevel, isRecording }) => {
    // audioLevel expected 0..100
    const fillHeight = Math.min(100, Math.max(0, Math.round(audioLevel)));
    const speakingThreshold = 10;

    // Use explicit green palette for mic check
    const primaryGreen = '#51d3a8ff'; // Tailwind emerald-500
    const lightGreen = '#A7F3D0';
    const mutedGray = '#a2a6afff';

    let label = 'Mic Check';
    let iconClass = 'text-white';
    let gradientTop = mutedGray;

    if (isRecording || fillHeight > 0) {
        if (fillHeight > speakingThreshold) {
            gradientTop = primaryGreen;
            label = 'Speaking';
            iconClass = 'text-gray-400';
        } else {
            gradientTop = '#6EE7B7'; // lighter green
            label = 'Low Volume';
            iconClass = 'text-gray-400';
        }
    } else {
        gradientTop = mutedGray;
        label = 'Silence';
        iconClass = 'text-gray-400';
    }

    return (
        <div className="flex flex-col items-center justify-center space-y-1">
            <div className="relative w-20 h-20 rounded-full bg-white overflow-hidden shadow-inner border-2 border-gray-200">
                {/* Visual Fill based on audioLevel: gradient from green -> very light */}
                <div
                    className={`absolute bottom-0 left-0 right-0 transition-all duration-100 ease-out`}
                    style={{
                        height: `${fillHeight}%`,
                        background: `linear-gradient(to top, ${gradientTop} 0%, ${lightGreen} 100%)`
                    }}
                />

                {/* Center icon */}
                <div className={`absolute inset-0 flex items-center justify-center`}> 
                    <svg xmlns="http://www.w3.org/2000/svg" className={`h-8 w-8 ${iconClass}`} viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3z" />
                        <path d="M19 11a7 7 0 01-7 7v2a9 9 0 009-9h-2z" opacity="0.8" />
                    </svg>
                </div>
            </div>
            <p className="text-xs font-semibold text-gray-600">{label}</p>
        </div>
    );
});

/**
 * Circular Timer 
 */
const TimerDisplay = React.memo(({ elapsedTime, isRecording }) => {
    const timeFormatted = formatTime(elapsedTime);
    const color = isRecording ? 'bg-indigo-600' : 'bg-gray-500';

    return (
        <div className="flex flex-col items-center justify-center space-y-1">
            <div className={`w-20 h-20 rounded-full flex flex-col items-center justify-center shadow-lg transition-colors duration-300 ${color}`}>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xl font-bold text-white tabular-nums">{timeFormatted}</span>
            </div>
            <p className="text-xs font-semibold text-gray-600">
                Record Time
            </p>
        </div>
    );
});


/**
 * Main application component for the Web Interview Recorder.
 */
const App = () => {
    console.log('App render: rendering React app (view state visible in console)');
    // --- State Management ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [view, setView] = useState('login'); // 'login', 'interview', 'complete'
    
    // Interviewee Form State
    const [token, setToken] = useState('');
    const [userName, setUserName] = useState('');

    // Interviewer State
    const [interviewerKey, setInterviewerKey] = useState('');
    const [isInterviewerLoggedIn, setIsInterviewerLoggedIn] = useState(false);
    const [sessions, setSessions] = useState([]); // Stores sessions for the dashboard
    const [sessionMessage, setSessionMessage] = useState(''); // Dashboard status message
    const [newIntervieweeName, setNewIntervieweeName] = useState(''); // Form input state
    const [currentReviewSession, setCurrentReviewSession] = useState(null); // For detailed review view

    // General Message/Loading
    const [message, setMessage] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [sessionFinalized, setSessionFinalized] = useState(false);
    
    // Session State
    const [folderName, setFolderName] = useState('');
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0); 
    const [questions, setQuestions] = useState([]); // Stores the 5 selected questions

    // --- Review State (admin review UI) ---
    const [reviewLoading, setReviewLoading] = useState(false);
    const [reviewData, setReviewData] = useState(null);
    const [currentQIndex, setCurrentQIndex] = useState(0);
    const [reviewTab, setReviewTab] = useState('ai'); // 'ai' or 'human'
    const [questionTranscript, setQuestionTranscript] = useState('');
    const [questionTranscriptLoading, setQuestionTranscriptLoading] = useState(false);

    // Safety: compute the currently selected question metadata (if reviewData is available)
    const currentQuestionData = reviewData?.receivedQuestions?.[currentQIndex] || null;

    // AI analysis UI state: useState so we can update these values when transcripts are fetched
    const [aiMatchScore, setAiMatchScore] = useState(currentQuestionData?.ai_match_score || 0);
    const [aiFeedback, setAiFeedback] = useState(currentQuestionData?.ai_feedback || "");
    const [clarityScore, setClarityScore] = useState(5);
    const [confidenceScore, setConfidenceScore] = useState(5);
    const [comment, setComment] = useState('');
    const [isDraftLoaded, setIsDraftLoaded] = useState(false); // Khóa an toàn

    // Manual AI retry removed: AI runs in background server-side and does not provide a manual retry from the interview UI.
    // 1. Tự động TẢI (Auto-Load) với cơ chế Khóa
    useEffect(() => {
        if (view === 'admin_review' && currentReviewSession) {
            // Bước A: KHÓA lại ngay lập tức (không cho save lung tung)
            setIsDraftLoaded(false);

            const draftKey = `draft_${currentReviewSession.token || currentReviewSession.id}_Q${currentQIndex}`;
            const savedDraft = localStorage.getItem(draftKey);

            // Bước B: Điền dữ liệu vào ô (hoặc reset về rỗng)
            if (savedDraft) {
                const parsed = JSON.parse(savedDraft);
                setClarityScore(parsed.clarity || 5);
                setConfidenceScore(parsed.confidence || 5);
                setComment(parsed.text || '');
            } else {
                // Quan trọng: Phải reset về rỗng nếu không có bản nháp
                setClarityScore(5);
                setConfidenceScore(5);
                setComment('');
            }

            // Bước C: MỞ KHÓA (Cho phép save) sau 1 tích tắc
            // Dùng setTimeout để đảm bảo React đã cập nhật xong giao diện mới
            setTimeout(() => {
                setIsDraftLoaded(true);
            }, 50);
        }
    }, [currentQIndex, currentReviewSession, view]);


    // 2. Tự động LƯU (Auto-Save) chỉ khi ĐÃ MỞ KHÓA
    useEffect(() => {
        // Chỉ lưu khi đang xem review, có session và QUAN TRỌNG LÀ: isDraftLoaded = true
        if (view === 'admin_review' && currentReviewSession && isDraftLoaded) {
            const draftKey = `draft_${currentReviewSession.token || currentReviewSession.id}_Q${currentQIndex}`;
            
            const draftData = {
                clarity: clarityScore,
                confidence: confidenceScore,
                text: comment
            };
            
            localStorage.setItem(draftKey, JSON.stringify(draftData));
        }
    }, [clarityScore, confidenceScore, comment, currentReviewSession, currentQIndex, view, isDraftLoaded]);

    // --- Media Stream and Recording State  ---
    const [mediaStream, setMediaStream] = useState(null);
    // Status: pending -> granted/denied/error
    const [mediaAccessStatus, setMediaAccessStatus] = useState('pending'); 
    const videoRef = React.useRef(null); // Reference to the <video> element

    // Recording State
    const [isRecording, setIsRecording] = useState(false);
    const [mediaRecorder, setMediaRecorder] = useState(null);
    const recordedChunksRef = useRef([]); 
    const [uploadStatus, setUploadStatus] = useState('idle'); 
    // How many upload attempts have been made for the current question
    const [uploadAttemptCount, setUploadAttemptCount] = useState(0);
    // AI processing runs on the server in the background; we don't expose manual AI retry or block the interview flow

    // --- Timer and Volume State ---
    const [elapsedTime, setElapsedTime] = useState(0); // Timer state (in seconds)
    const timerIntervalRef = useRef(null); // Ref to hold the interval ID

    const [audioLevel, setAudioLevel] = useState(0); // Volume detector state (0-100)
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const animationFrameRef = useRef(null);


    // --- 1. Firebase Initialization and Authentication ---

    const populateQuestions = useCallback(async (dbInstance) => {
        const qBankRef = collection(dbInstance, "question_bank");
        try {
            const snapshot = await getDocs(qBankRef);
            if (snapshot.empty) {
                console.log("Question bank is empty. Populating with questions...");
                for (const q of QUESTIONS) {
                    await setDoc(doc(qBankRef, q.id), q);
                }
                console.log("Questions populated successfully.");
            } else {
                console.log(`Question bank has ${snapshot.size} questions. Skipping population.`);
            }
        } catch (e) {
            console.error("Error populating questions:", e);
        }
    }, []);

    useEffect(() => {
        // Initialize Firebase services
        if (Object.keys(firebaseConfig).length === 0) {
            console.error("Firebase configuration is missing or empty.");
            setIsAuthReady(true);
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestoreDb = getFirestore(app);
            const firebaseAuth = getAuth(app);
            
            setDb(firestoreDb);
            setAuth(firebaseAuth);

            // Auto-populate questions on initial load
            populateQuestions(firestoreDb);

            // Authentication listener to handle initial sign-in
            const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
                console.log("Auth state changed. User:", user ? user.uid : "null");
                if (!user) {
                    // Sign in with the provided token or anonymously
                    try {
                        if (initialAuthToken) {
                            console.log("Attempting custom token sign-in...");
                            await signInWithCustomToken(firebaseAuth, initialAuthToken);
                            console.log("Custom token sign-in successful.");
                        } else {
                            console.log("No custom token provided. Signing in anonymously...");
                            await signInAnonymously(firebaseAuth);
                            console.log("Anonymous sign-in successful.");
                        }
                    } catch (error) {
                        console.error("Sign-in failed:", error);
                        // Fall back to anonymous if custom token fails
                        if (initialAuthToken) {
                            try {
                                await signInAnonymously(firebaseAuth);
                                console.log("Fallback to anonymous sign-in successful.");
                            } catch (anonError) {
                                console.error("Even anonymous sign-in failed:", anonError);
                            }
                        }
                    }
                }
                // Once auth state is set, capture UID and mark readiness
                const uid = firebaseAuth.currentUser?.uid || crypto.randomUUID();
                console.log("Setting userId and marking auth ready. UID:", uid);
                setUserId(uid);
                setIsAuthReady(true);
                unsubscribe(); // Stop listening after initial setup
            });

        } catch (error) {
            console.error("Firebase initialization failed:", error);
            setIsAuthReady(true);
        }
    }, [populateQuestions]);
    
    
    // --- 2. Question Fetching and Selection ---
    
    const fetchAndSelectQuestions = useCallback(async () => {
        if (!db) {
            setMessage('Error: Firestore client not ready.');
            return false;
        }

        try {
            const qBankRef = collection(db, "question_bank");
            const snapshot = await getDocs(qBankRef);

            if (snapshot.empty) {
                setMessage("Error: Question bank is empty. Cannot start interview.");
                return false;
            }

            const allQuestions = snapshot.docs.map(doc => doc.data());

            // If the session already has selected questions persisted, prefer those
            if (token && token.trim()) {
                try {
                    const sessionDocRef = doc(db, 'sessions', token.trim());
                    const sessionSnap = await getDoc(sessionDocRef);
                    if (sessionSnap.exists()) {
                        const sessData = sessionSnap.data();
                        const persisted = sessData?.questionsSelected || sessData?.metadata_initial?.questionsSelected;
                        if (Array.isArray(persisted) && persisted.length >= MAX_QUESTIONS) {
                            // Map persisted entries (which may be {id,text} or strings) back to full question objects when possible
                            const mapped = persisted.slice(0, MAX_QUESTIONS).map(item => {
                                if (item && typeof item === 'object' && item.id) {
                                    const found = allQuestions.find(q => q.id === item.id);
                                    return found || { id: item.id, text: item.text || '' };
                                } else {
                                    // try to match by text
                                    const found = allQuestions.find(q => q.text === String(item));
                                    return found || { id: '', text: String(item) };
                                }
                            });
                            setQuestions(mapped);
                            console.log('Using persisted questionsSelected from Firestore for session', token.trim());
                            return true;
                        }
                    }
                } catch (e) {
                    console.warn('Failed to read persisted questionsSelected from Firestore:', e);
                }
            }

            // --- Category-balanced Random Selection Logic (one per category) ---
            // Detect categories dynamically from the 2-letter prefix before the underscore
            const grouped = {};
            for (const q of allQuestions) {
                const prefix = (q.id || '').split('_')[0] || '';
                if (!grouped[prefix]) grouped[prefix] = [];
                grouped[prefix].push(q);
            }

            // Prefer a fixed category order: SI, IN, DF, PS, SS
            const preferredOrder = ['SI', 'IN', 'DF', 'PS', 'SS'];
            // Start with preferred categories that exist in the bank (preserve their order)
            let categories = preferredOrder.filter(p => grouped[p] && grouped[p].length > 0).slice(0, MAX_QUESTIONS);

            // If we still need more categories (preferred list too short), append other prefixes
            if (categories.length < MAX_QUESTIONS) {
                for (const q of allQuestions) {
                    const prefix = (q.id || '').split('_')[0] || '';
                    if (prefix && grouped[prefix] && !categories.includes(prefix)) {
                        categories.push(prefix);
                    }
                    if (categories.length >= MAX_QUESTIONS) break;
                }
            }

            // Pick one random question from each selected category
            const selected = [];
            for (const cat of categories) {
                const pool = grouped[cat] || [];
                if (pool.length > 0) {
                    const pick = pool[Math.floor(Math.random() * pool.length)];
                    selected.push(pick);
                }
            }

            // If we still need more questions (e.g., fewer categories than MAX_QUESTIONS), fill from remaining pool
            if (selected.length < MAX_QUESTIONS) {
                const selectedIds = new Set(selected.map(s => s.id));
                const remaining = allQuestions.filter(q => !selectedIds.has(q.id));
                // Shuffle remaining
                for (let i = remaining.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
                }
                let idx = 0;
                while (selected.length < MAX_QUESTIONS && idx < remaining.length) {
                    selected.push(remaining[idx]);
                    idx += 1;
                }
            }

            const selectedQuestions = selected.slice(0, MAX_QUESTIONS);

            setQuestions(selectedQuestions);

            // Persist selected questions to Firestore under the session document
            // so the server can include the question text in transcripts.
            try {
                if (token && token.trim()) {
                    // Store minimal question objects (id + text) for server lookup
                    const questionsToSave = selectedQuestions.map(q => ({ id: q.id, text: q.text }));
                    const sessionDocRef = doc(db, 'sessions', token.trim());

                    // Retry logic for transient Firestore write issues
                    let saved = false;
                    let attempt = 0;
                    while (!saved && attempt < 3) {
                        attempt += 1;
                        try {
                            await setDoc(sessionDocRef, { questionsSelected: questionsToSave }, { merge: true });
                            saved = true;
                            console.log(`Saved selected questions to Firestore for session ${token.trim()} (attempt ${attempt})`);
                        } catch (writeErr) {
                            console.warn(`Attempt ${attempt} failed to save questionsSelected:`, writeErr);
                            // small backoff
                            await new Promise(r => setTimeout(r, 250 * attempt));
                        }
                    }
                    if (!saved) {
                        console.error('Failed to save selected questions to Firestore after retries.');
                    }
                } else {
                    console.warn('No token available to save selected questions to Firestore.');
                }
            } catch (e) {
                console.error('Failed to save selected questions to Firestore:', e);
            }

            console.log("Selected Questions for this session:", selectedQuestions);
            return true;

        } catch (error) {
            setMessage("Error: Failed to load questions. Check database connection and data.");
            console.error("Error fetching questions from Firestore:", error);
            return false;
        }
    }, [db, token]);
    

    // --- 3. Media Access and Volume Analysis ---

    const analyzeVolume = useCallback(() => {
        // Run this only if media is granted AND we are in the interview view
        if (!analyserRef.current || !dataArrayRef.current || view !== 'interview' || mediaAccessStatus !== 'granted') {
             // Stop the loop if the conditions are not met
             if (animationFrameRef.current) {
                 cancelAnimationFrame(animationFrameRef.current);
                 animationFrameRef.current = null;
             }
             return; 
        }

        // Get new volume data
        analyserRef.current.getByteFrequencyData(dataArrayRef.current);
        
        // Calculate RMS (Root Mean Square) for volume
        let sumOfSquares = 0;
        for(let i = 0; i < dataArrayRef.current.length; i++) {
            sumOfSquares += dataArrayRef.current[i] * dataArrayRef.current[i];
        }
        const rms = Math.sqrt(sumOfSquares / dataArrayRef.current.length);
        
        // Scale RMS (0-255) to a percentage (0-100)
        // FIX: Increase sensitivity by multiplying by 1.5 before capping at 100
        const scaledLevel = Math.min(100, Math.round((rms / 255) * 150));
        setAudioLevel(scaledLevel);

        // Loop the animation
        animationFrameRef.current = requestAnimationFrame(analyzeVolume);
    }, [view, mediaAccessStatus]);

    const requestMediaAccess = useCallback(async () => {
        setMediaAccessStatus('pending');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
            });
            setMediaStream(stream);
            setMediaAccessStatus('granted');
            
            // --- Initialize Audio Context for Volume Detection ---
            let audioContext = audioContextRef.current || new (window.AudioContext || window.webkitAudioContext)();
            
            // Critical: Disconnect any existing analyser node before creating a new connection
            // We ensure we only connect the stream once
            if (analyserRef.current) {
                analyserRef.current.disconnect();
            }

            const mediaStreamSource = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            
            analyser.smoothingTimeConstant = 0.8;
            analyser.fftSize = 2048; 
            
            mediaStreamSource.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            
            audioContextRef.current = audioContext;
            analyserRef.current = analyser;
            dataArrayRef.current = dataArray;
            
        } catch (error) {
            console.error("Media access denied or error:", error);
            setMediaAccessStatus('denied');
        }
    }, []);
    
    // --- Dedicated Effect to manage Media Stream, Video, and Volume attachment ---
    useEffect(() => {
        if (view === 'interview') {
            if (mediaAccessStatus === 'pending') {
                requestMediaAccess();
            }
            
            if (mediaAccessStatus === 'granted') {
                 // Check and resume audio context on a user-driven action (like switching to 'interview')
                 if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
                     audioContextRef.current.resume().catch(e => console.error("AudioContext resume failed:", e));
                 }
                 
                 // Start volume visualization loop only when media is granted
                if (!animationFrameRef.current) {
                    animationFrameRef.current = requestAnimationFrame(analyzeVolume);
                }
            }
        }
        
        if (videoRef.current && mediaStream && mediaAccessStatus === 'granted') {
            videoRef.current.srcObject = mediaStream;
        }

        return () => {
            // Stop animation loop
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
            // Stop interval timer if left running
            if (timerIntervalRef.current) {
                 clearInterval(timerIntervalRef.current);
                 timerIntervalRef.current = null;
            }
        };
    }, [view, requestMediaAccess, mediaStream, mediaAccessStatus, analyzeVolume]);

    // When the interview view starts and Firestore client is ready, fetch and select questions
    useEffect(() => {
        if (view === 'interview' && db && questions.length === 0) {
            fetchAndSelectQuestions();
        }
    }, [view, db, fetchAndSelectQuestions, questions.length]);


    // --- 4. Recording and Timer Functions ---

    const startRecording = useCallback(() => {
        if (!mediaStream || questions.length === 0 || isRecording) {
            setMessage("Error: Cannot start recording.");
            return;
        }
        
        // FIX: Ensure AudioContext resumes explicitly before recording starts,
        // as this is a reliable user gesture.
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
             audioContextRef.current.resume().catch(e => console.error("AudioContext resume failed:", e));
        }

        recordedChunksRef.current = [];
        
        const recorder = new MediaRecorder(mediaStream, { mimeType: 'video/webm; codecs=vp8,opus' });

        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunksRef.current.push(event.data);
            }
        };

        recorder.onstop = async () => {
            // Recording stopped — ready to upload
            setUploadStatus('stopped');
            // Timer stop logic 
            if (timerIntervalRef.current) {
                 clearInterval(timerIntervalRef.current);
                 timerIntervalRef.current = null;
            }
        };

        recorder.start(1000); 
        setMediaRecorder(recorder);
        setIsRecording(true);
        setUploadStatus('recording');
        setMessage(`Recording Q${currentQuestionIndex + 1}: ${questions[currentQuestionIndex].id}`);
        
        // Start Timer
        setElapsedTime(0); 
        timerIntervalRef.current = setInterval(() => {
            setElapsedTime(prevTime => prevTime + 1);
        }, 1000);

    }, [mediaStream, currentQuestionIndex, questions, isRecording]);

    const stopRecording = useCallback(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop(); 
            setIsRecording(false);
            setMediaRecorder(null);
            setMessage(`Recording stopped for Q${currentQuestionIndex + 1}. Press 'Upload' to proceed.`);
        }
    }, [mediaRecorder, currentQuestionIndex]);
    

    // --- 5. Core Interview Flow Handlers ---
    
    // Exponential Backoff Retry
    const uploadWithRetry = useCallback(async (videoBlob, currentAttempt = 0) => {
        const questionNumber = currentQuestionIndex + 1;

        // currentAttempt starts at 0; allow up to MAX_RETRIES attempts total
        if (currentAttempt >= MAX_RETRIES) {
            setUploadStatus('failed');
            setMessage(`Upload Failed after ${MAX_RETRIES} attempts. Please try manual retry.`);
            console.error(`Upload failed after ${MAX_RETRIES} attempts.`);
            setUploadAttemptCount(currentAttempt);
            return;
        }

        if (currentAttempt > 0) {
            // Calculate exponential backoff delay: BASE_DELAY_MS * 2^(attempt - 1)
            const delay = BASE_DELAY_MS * Math.pow(2, currentAttempt - 1);
            setUploadStatus('retry');
            setUploadAttemptCount(currentAttempt);
            setMessage(`Retrying Q${questionNumber} in ${delay / 1000}s (Attempt ${currentAttempt + 1}/${MAX_RETRIES})...`);
            console.log(`Retrying upload Q${questionNumber}, attempt ${currentAttempt}. Delay: ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // --- Prepare Multipart Form Data ---
        const formData = new FormData();
        formData.append('token', token);
        formData.append('folder', folderName);
        formData.append('questionIndex', String(currentQuestionIndex));
        // Provide question text as a convenience so server does not need to rely on Firestore lookup
        const questionTextForUpload = questions[currentQuestionIndex]?.text || '';
        formData.append('questionText', questionTextForUpload);
        // Append the video blob with the required filename (Q*.webm)
        formData.append('video', videoBlob, `Q${questionNumber}.webm`);

        setUploadStatus('uploading');
        setUploadAttemptCount(currentAttempt + 1);
        if (currentAttempt === 0) {
             setMessage(`Uploading Q${questionNumber}...`);
        }
        
        try {
            const response = await fetch(`${API_BASE_URL}/upload-one`, {
                method: 'POST',
                // IMPORTANT: Do NOT set 'Content-Type' header here. The browser sets it automatically for FormData, including the boundary.
                body: formData,
            });
            
            if (!response.ok) {
                // Parse error details if available
                const errorData = await response.json().catch(() => ({ detail: 'Unknown Server Error' }));
                console.error(`Upload failed (HTTP ${response.status}):`, errorData.detail);

                // Decide whether to retry: retry on 5xx and 429, not on 4xx client errors
                if (response.status >= 500 || response.status === 429) {
                    await uploadWithRetry(videoBlob, currentAttempt + 1);
                    return;
                } else {
                    // Non-retriable client error — mark failed
                    setUploadStatus('failed');
                    setMessage(`Upload failed: ${errorData.detail || `HTTP ${response.status}`}`);
                    return;
                }
            }
            
            // --- SUCCESS ---
            setUploadStatus('success');
            setUploadAttemptCount(0);
            setMessage(`Upload success for Q${questionNumber}. AI analysis running in background.`);
            recordedChunksRef.current = []; // Clear chunks after successful upload

        } catch (error) {
            // If network error (e.g., Failed to fetch, connection refused), trigger retry
            console.error(`Network error during upload Q${questionNumber}:`, error);
            await uploadWithRetry(videoBlob, currentAttempt + 1);
        }
    }, [token, folderName, currentQuestionIndex, questions]);


    const handleUploadVideo = useCallback(() => {
        // Triggers the upload process, whether it's the first time or a manual retry
        if (uploadStatus !== 'stopped' && uploadStatus !== 'failed') return;
        
        const videoBlob = new Blob(recordedChunksRef.current, { type: 'video/webm' });

        // Start the upload process with the retry mechanism (attempt 0)
        uploadWithRetry(videoBlob);

    }, [uploadStatus, uploadWithRetry]);


    const handleNextQuestion = () => {
        if (uploadStatus !== 'success') {
             setMessage("Error: Please upload the current question's video first.");
             return;
        }
        
        if (currentQuestionIndex < MAX_QUESTIONS - 1) {
            setCurrentQuestionIndex(prev => prev + 1);
            setUploadStatus('idle'); 
            // AI runs in background; do not block next question
            setUploadAttemptCount(0);
            setMessage(`Ready for Q${currentQuestionIndex + 2}.`);
            setElapsedTime(0);

        } else {
            // Switch to the dedicated 'complete' view
            setView('complete');
            setMessage('All questions answered! Finalizing session...');
        }
    }
    
    // Final API call to close the session
    const handleFinishSession = async () => {
        setIsLoading(true);
        setMessage('Finalizing session on server...');
        
        const formData = new FormData();
        formData.append('token', token);
        formData.append('folder', folderName);
        formData.append('questionsCount', String(MAX_QUESTIONS));
        
        try {
            const resp = await fetch(`${API_BASE_URL}/session/finish`, {
                method: 'POST',
                body: formData,
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: `HTTP ${resp.status}` }));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            setMessage('Session successfully finalized! Thank you for completing the interview. You may now close this window.');
            setSessionFinalized(true);
        } catch (error) {
             setMessage(`Error finalizing session: ${error.message}`);
        } finally {
            setIsLoading(false);
        }
    }

    // Return the user to the initial login page and reset local UI/session state
    const handleReturnToLogin = () => {
        // Stop any active media tracks
        try {
            if (mediaStream) {
                mediaStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (e) { /* ignore */ }
                });
            }
        } catch (e) {
            console.warn('Error stopping media tracks:', e);
        }

        // Reset UI/session state
        setMediaStream(null);
        setFolderName('');
        setQuestions([]);
        setCurrentQuestionIndex(0);
        setUploadStatus('idle');
        setElapsedTime(0);
        setMessage('');
        setIsRecording(false);
        setIsAuthReady(true);

        // Clear interviewee form fields
        setToken('');
        setUserName('');

        // Return to the login view
        setSessionFinalized(false);
        setView('login');
    };


    // --- 6. API Communication Functions ---

    const callApi = useCallback(async (endpoint, data) => {
        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data),
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || `Network Error: ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error(`API call to ${endpoint} failed:`, error);
            throw error;
        }
    }, []);


    const handleLogin = async (e) => {
        e.preventDefault();
        setMessage('');
        setIsLoading(true);

        const requestBody = { token: token.trim(), user_name: userName.trim() };

        if (!requestBody.token || !requestBody.user_name) {
            setMessage("Token and Name are required.");
            setIsLoading(false);
            return;
        }
        
        try {
            setMessage('1/2: Verifying session token...');
            await callApi('/verify-token', requestBody);

            setMessage('2/2: Starting session and reserving server space...');
            const sessionResponse = await callApi('/session/start', requestBody);

            setFolderName(sessionResponse.folder);
            
            setMessage(`Success! Session started. Folder: ${sessionResponse.folder}. Selecting questions...`);
            // Ensure questions are selected & persisted before entering the interview view so uploads include question text
            const selectedOk = await fetchAndSelectQuestions();
            if (!selectedOk) {
                setMessage('Warning: Failed to load or persist selected questions. Please wait a moment and retry Start Interview.');
                // Keep user on login view to avoid uploading without question text
                setIsLoading(false);
                return;
            }

            setMessage(`Success! Session ready. Folder: ${sessionResponse.folder}.`);
            setMediaAccessStatus('pending'); 
            setView('interview'); 
            setCurrentQuestionIndex(0); 
            setUploadStatus('idle');

        } catch (error) {
            setMessage(`Login Failed: ${error.message}`);
        } finally {
            setIsLoading(false);
        }
    };


    // --- 7. Interviewer Login Logic ---

    const handleInterviewerLogin = (e) => { 
        e.preventDefault();
        setMessage('');
        setIsLoading(true);

        if (interviewerKey === ADMIN_AUTH_KEY) {
            // Assign a stable, known admin user id so interviewer sessions are
            // consistently attributed to the same admin account.
            const ADMIN_FIXED_UID = '4b92e833-1afa-4aa2-bb8f-983ce093aaeb';
            setUserId(ADMIN_FIXED_UID);
            setIsInterviewerLoggedIn(true);
            setView('admin_dashboard');
        } else {
            setMessage("Invalid Admin Key.");
        }
        setIsLoading(false);
    };
    
    // Component: Form to create new session tokens
    const SessionCreator = () => {
        const [name, setName] = useState('');
        const [tokenOutput, setTokenOutput] = useState('');
        const [isCreating, setIsCreating] = useState(false);
        const [createMessage, setCreateMessage] = useState('');

        const handleCreateSession = async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            
            setIsCreating(true);
            setCreateMessage('Generating token...');
            
            const requestBody = {
                interviewee_name: name.trim(),
                interviewer_id: userId // Use the authenticated interviewer's ID
            };
            
            try {
                const response = await callApi('/interviewer/create-session', requestBody);
                setTokenOutput(response.token);
                setCreateMessage(`Success! Share this token: ${response.token}. URL: ${response.session_url}`);
                setName(''); // Clear form
                // Force session refresh in dashboard
                fetchSessions(); 
            } catch (error) {
                setCreateMessage(`Error creating session: ${error.message}`);
            } finally {
                setIsCreating(false);
            }
        };

        return (
            <div className="p-6 border border-indigo-200 rounded-xl bg-indigo-50 shadow-md">
                <h3 className="text-xl font-bold text-indigo-700 mb-4">1. Create New Interview Session</h3>
                <form onSubmit={handleCreateSession} className="space-y-4">
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Interviewee Name (e.g., Jane Doe)"
                        required
                        disabled={isCreating}
                        className="w-full px-3 py-2 border border-indigo-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
                    />
                    <button
                        type="submit"
                        disabled={isCreating || !userId}
                        className="w-full py-2 px-4 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition"
                    >
                        {isCreating ? 'Generating...' : 'Generate New Token'}
                    </button>
                </form>
                {createMessage && (
                    <div className={`mt-4 p-3 rounded-lg text-sm font-medium break-all ${tokenOutput ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {createMessage}
                    </div>
                )}
            </div>
        );
    };

    // Component: Table listing all sessions for the current interviewer
    const SessionsTable = () => {
        return (
            <div className="p-6 border border-gray-200 rounded-xl bg-white shadow-md">
                <h3 className="text-xl font-bold text-gray-700 mb-4">2. Current Sessions ({sessions.length})</h3>
                <div className="flex items-center justify-between text-sm text-gray-500 mb-3">
                    <div>{sessionMessage}</div>
                    <button
                        onClick={fetchSessions}
                        className="px-3 py-1 text-xs bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition"
                    >
                        Refresh List
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Candidate</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Token</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {sessions.length === 0 ? (
                                <tr>
                                    <td colSpan="4" className="px-6 py-4 text-sm text-gray-500 text-center">No sessions found for this interviewer.</td>
                                </tr>
                            ) : (
                                sessions.map((session) => (
                                    <tr key={session.id}>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{session.interviewee_name}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{session.token}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                                            <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                                session.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                                                session.status === 'complete' ? 'bg-green-100 text-green-800' :
                                                session.status.includes('uploaded') ? 'bg-blue-100 text-blue-800' :
                                                'bg-gray-100 text-gray-800'
                                            }`}>
                                                {session.status.toUpperCase().replace(/_/g, ' ')}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                                            <button 
                                                onClick={() => {
                                                    setCurrentReviewSession(session);
                                                    setView('admin_review');
                                                }}
                                                // Only enable Review if at least one question has been uploaded
                                                disabled={session.status === 'pending' || session.status === 'active'}
                                                className={`text-indigo-600 hover:text-indigo-900 transition disabled:text-gray-400`}
                                            >
                                                Review
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        );
    };

    // --- Review data fetcher (used by admin review view) ---
    const fetchReviewData = useCallback(async () => {
        if (!db || !currentReviewSession) return;
        setReviewLoading(true);
        setReviewData(null);

        try {
            // Determine token and folder from the session object (be permissive)
            const tokenVal = currentReviewSession?.token || currentReviewSession?.id || currentReviewSession?.session_id || '';

            // Try to resolve folder name from multiple possible fields
            // Prioritize persisted metadata in Firestore session doc, then session fields
            const sessionDocRef = doc(db, 'sessions', tokenVal);
            const sessionSnap = await getDoc(sessionDocRef);
            const metadata = sessionSnap.exists() ? sessionSnap.data() : (currentReviewSession || {});

            const folder = metadata?.metadata_initial?.folderName || metadata?.folder_name || metadata?.folder || metadata?.folderName || currentReviewSession?.folder_name || currentReviewSession?.folder || tokenVal;

            const videoBaseUrl = `${API_BASE_URL.replace('/api', '/uploads/')}${folder}/`;

            const receivedQ = metadata?.metadata_initial?.receivedQuestions || metadata?.receivedQuestions || {};
            const questionKeys = Object.keys(receivedQ).length > 0 ? Object.keys(receivedQ).map(k => parseInt(k, 10)).filter(n => !Number.isNaN(n)) : [];

            // NOTE: The server now writes per-question transcript files (e.g., Q1_transcript.txt).
            const transcriptText = '';

            // Default to first available question index
            let startIndex = 0;
            if (questionKeys.length > 0) {
                questionKeys.sort((a, b) => a - b);
                startIndex = questionKeys[0];
            }

            setCurrentQIndex(startIndex);
            const metaUrl = `${videoBaseUrl}meta.json`;

            setReviewData({
                receivedQuestions: receivedQ,
                availableQIndexes: questionKeys,
                transcript: transcriptText,
                videoBaseUrl,
                metaUrl   // ⭐ QUAN TRỌNG: thêm dòng này
            });

        } catch (e) {
            console.error('Review data fetch error:', e);
            setReviewData({ error: `Failed to load review data. ${e?.message || e}` });
        } finally {
            setReviewLoading(false);
        }
    }, [db, currentReviewSession]);

    useEffect(() => {
        if (db && currentReviewSession) fetchReviewData();
    }, [db, currentReviewSession, fetchReviewData]);

    // File: app.jsx
    // ... (Các dòng code trước đó)
    // Fetch per-question transcript (meta.json-backed)
    const fetchTranscriptForQuestion = useCallback(async (qIndex) => {
        // ⭐ QUAN TRỌNG: Gọi reset các state AI khi load câu hỏi mới
        setAiMatchScore(0);
        setAiFeedback("");
        
        if (!reviewData || !reviewData.metaUrl) return '';
        setQuestionTranscriptLoading(true);
        // Đặt tạm text cũ hoặc rỗng để tránh hiện text của câu trước khi đang load câu sau
        setQuestionTranscript(''); 

        try {
            // Thêm timestamp để tránh Browser Cache file json cũ
            const res = await fetch(`${reviewData.metaUrl}?t=${new Date().getTime()}`);
            if (!res.ok) throw new Error('Failed to load meta.json');

            const arrayBuffer = await res.arrayBuffer();
            const decoder = new TextDecoder("utf-8");
            const text = decoder.decode(arrayBuffer);
            const meta = JSON.parse(text);

            // --- BẮT ĐẦU SỬA Ở ĐÂY ---
            const key = String(qIndex);
            const item = meta.receivedQuestions ? meta.receivedQuestions[key] : null;

            if (item) {
                // Lấy dữ liệu 
                const transcript = item.transcript_text || 'Transcript not found.';
                const score = item.ai_match_score || 0;
                const feedback = item.ai_feedback || '';
                
                // Cập nhật tất cả các state
                setQuestionTranscript(transcript);
                setAiMatchScore(score); // ⭐ THÊM DÒNG NÀY
                setAiFeedback(feedback); // ⭐ THÊM DÒNG NÀY
                setQuestionTranscriptLoading(false);
                
                return transcript;
            }
            // --- KẾT THÚC SỬA Ở ĐÂY ---

        } catch (err) {
            console.error('Error loading transcript:', err);
        }

        setQuestionTranscript('Transcript not found for this question.');
        setQuestionTranscriptLoading(false);
        return "";
    }, [reviewData, setAiMatchScore, setAiFeedback]); // ⭐ THÊM setAiMatchScore, setAiFeedback vào dependencies
    // ... (Các dòng code sau đó)

    // Load transcript when reviewData or currentQIndex changes (AI tab)
    useEffect(() => {
        if (reviewTab === 'ai' && reviewData) {
            fetchTranscriptForQuestion(currentQIndex);
        }
    }, [reviewData, currentQIndex, reviewTab, fetchTranscriptForQuestion]);

    // --- BẮT ĐẦU ĐOẠN CODE CẦN CHÈN (POLLING) ---
    // Tự động kiểm tra lại sau mỗi 3 giây nếu trạng thái đang là "Processing..."
    useEffect(() => {
        let intervalId;

        // Nếu text hiện tại là "Processing...", nghĩa là AI chưa xong -> Cần check lại
        if (questionTranscript === "Processing...") {
            console.log("⏳ AI đang xử lý, sẽ kiểm tra lại sau 3s...");
        
            intervalId = setInterval(() => {
                // Gọi lại hàm lấy dữ liệu để xem có text mới chưa
                fetchTranscriptForQuestion(currentQIndex);
            }, 3000); // 3000ms = 3 giây
        }

        // Dọn dẹp khi component thay đổi hoặc đã có kết quả
        return () => {
            if (intervalId) clearInterval(intervalId);
        };
    }, [questionTranscript, currentQIndex, fetchTranscriptForQuestion]);
    // --- KẾT THÚC ĐOẠN CODE CẦN CHÈN ---


    // --- Session Fetching for Interviewer Dashboard ---
    const fetchSessions = useCallback(async () => {
        if (!db || !userId || !isInterviewerLoggedIn) return;

        setSessionMessage('Loading sessions...');
        try {
            // Mandatory Query: Filter sessions created by the current logged-in Interviewer (userId)
            const sessionsRef = collection(db, "sessions");
            const q = query(sessionsRef, where("interviewer_id", "==", userId));
            // NOTE: orderBy is excluded to avoid index errors, data is sorted client-side if needed.
            const snapshot = await getDocs(q);

            const sessionsData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                token: doc.id, // Ensure token is available
            }));
            
            // Sort sessions by creation date (newest first) client-side
            sessionsData.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            
            setSessions(sessionsData);
            setSessionMessage(`Found ${sessionsData.length} sessions.`);

        } catch (error) {
            console.error("Error fetching interviewer sessions:", error?.toString ? error.toString() : error, error);
            setSessionMessage("Failed to load sessions. Check Firestore rules/connection and browser console for details.");
        }
    }, [db, userId, isInterviewerLoggedIn]);

    // Effect to fetch sessions whenever the dashboard loads or userId changes
    useEffect(() => {
        if (view === 'admin_dashboard') {
            fetchSessions();
        }
    }, [view, fetchSessions]);


    // --- 8. Render Functions ---

    const renderLogin = () => (
        // ... (renderLogin component remains the same)
        <div className="p-8 bg-white shadow-xl rounded-xl w-full max-w-md">
            <h2 className="text-3xl font-bold text-gray-800 mb-6 text-center">
                Interviewee Login
            </h2>
            <p className="text-sm text-gray-500 mb-6 text-center">
                Enter the unique Token and your Name provided by the interviewer.
            </p>
            
            <form onSubmit={handleLogin} className="space-y-6">
                <div>
                    <label htmlFor="token" className="block text-sm font-medium text-gray-700">
                        Session Token
                    </label>
                    <input
                        id="token"
                        type="text"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="e.g., demo123"
                        required
                        disabled={isLoading}
                        className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500 transition duration-150"
                    />
                </div>
                <div>
                    <label htmlFor="userName" className="block text-sm font-medium text-gray-700">
                        Your Full Name
                    </label>
                    <input
                        id="userName"
                        type="text"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                        placeholder="e.g., John Smith"
                        required
                        disabled={isLoading}
                        className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500 transition duration-150"
                    />
                </div>
                
                <button
                    type="submit"
                    disabled={isLoading || !isAuthReady}
                    className={`w-full py-3 px-4 border border-transparent rounded-lg shadow-md text-white font-semibold transition duration-300 
                        ${isLoading ? 'bg-indigo-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'}`}
                >
                    {isLoading ? 'Processing...' : 'Start Interview'}
                </button>
            </form>

            {(message || !isAuthReady) && (
                <div className={`mt-6 p-3 rounded-lg text-sm font-medium ${message.includes('Success') ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {isAuthReady ? message : 'Connecting to services...'}
                </div>
            )}
            
            <button 
                onClick={() => setView('admin_login')}
                className="mt-6 w-full text-sm text-center text-gray-500 hover:text-gray-700 transition"
            >
                Interviewer Login
            </button>
            
            {/* Display UserId for debugging and compliance */}
            <p className="mt-4 text-xs text-gray-400 text-center break-all">
                User ID: {userId || 'Authenticating...'}
            </p>
        </div>
    );
    
    const renderInterviewerLogin = () => (
        // ... (renderInterviewerLogin component remains the same)
        <div className="p-8 bg-white shadow-xl rounded-xl w-full max-w-md">
            <h2 className="text-3xl font-bold text-gray-800 mb-6 text-center text-indigo-700">
                Interviewer Access
            </h2>
            <p className="text-sm text-gray-500 mb-6 text-center">
                Enter the Admin Key to manage sessions and review submissions.
            </p>
            
            <form onSubmit={handleInterviewerLogin} className="space-y-6">
                <div>
                    <label htmlFor="interviewerKey" className="block text-sm font-medium text-gray-700">
                        Admin Key
                    </label>
                    <input
                        id="interviewerKey"
                        type="password"
                        value={interviewerKey}
                        onChange={(e) => setInterviewerKey(e.target.value)}
                        placeholder="ADMIN123"
                        required
                        disabled={isLoading}
                        className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500 transition duration-150"
                    />
                </div>
                
                <button
                    type="submit"
                    disabled={isLoading}
                    className={`w-full py-3 px-4 border border-transparent rounded-lg shadow-md text-white font-semibold transition duration-300 bg-indigo-600 hover:bg-indigo-700`}
                >
                    {isLoading ? 'Checking...' : 'Login as Admin'}
                </button>
            </form>

            {message && (
                <div className={`mt-6 p-3 rounded-lg text-sm font-medium bg-red-100 text-red-700`}>
                    {message}
                </div>
            )}

            <button 
                onClick={() => setView('login')}
                className="mt-4 w-full text-sm text-center text-gray-500 hover:text-gray-700 transition"
            >
                &larr; Back to Interviewee Login
            </button>
        </div>
    );

    const renderInterviewerDashboard = () => (
        <div className="p-8 bg-white shadow-2xl rounded-xl w-full max-w-6xl">
            <h2 className="text-3xl font-extrabold text-gray-800 mb-4">Interviewer Dashboard</h2>
            <p className="text-gray-500 mb-6">
                Logged in as Admin. User ID: {userId}.
            </p>

            <div className="space-y-8">
                {/* 1. Session Creation Component */}
                <SessionCreator />

                {/* 2. Sessions Management Component */}
                <SessionsTable />
            </div>

            <button 
                onClick={handleReturnToLogin} // Use centralized return function
                className="mt-8 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
            >
                Logout
            </button>
        </div>
    );

    // Full Review Interface (video, transcript, navigation, scoring)
    const renderReviewInterface = () => {
        if (!currentReviewSession || typeof currentReviewSession !== 'object') {
            return (
                <div className="p-8 bg-white shadow-2xl rounded-xl w-full max-w-md text-center">
                    <h2 className="text-3xl font-extrabold text-gray-800 mb-4">No Session Selected</h2>
                    <p className="text-sm text-gray-600 mb-4">Please select a session from the dashboard to review.</p>
                    <button 
                        onClick={() => setView('admin_dashboard')}
                        className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg"
                    >
                        Go to Dashboard
                    </button>
                </div>
            );
        }

        const candidateName = currentReviewSession?.interviewee_name || currentReviewSession?.candidate || 'Unknown Candidate';
        const tokenVal = currentReviewSession?.token || currentReviewSession?.id || currentReviewSession?.session_id || 'N/A';

        if (reviewLoading) {
            return (
                <div className="p-8 bg-white shadow-2xl rounded-xl w-full max-w-md text-center">
                    <div className="animate-spin inline-block w-8 h-8 border-4 border-indigo-300 border-t-indigo-600 rounded-full mb-3"></div>
                    <h2 className="text-xl font-extrabold text-gray-800">Loading Review Data...</h2>
                    <p className="text-sm text-gray-500">Fetching videos and transcripts from server.</p>
                </div>
            );
        }

        if (reviewData?.error) {
            return (
                <div className="p-8 bg-white shadow-2xl rounded-xl w-full max-w-md text-center">
                    <h2 className="text-3xl font-extrabold text-red-700 mb-4">Review Error</h2>
                    <p className="text-gray-700 mb-4">{reviewData.error}</p>
                    <button onClick={() => setView('admin_dashboard')} className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg">
                        Go to Dashboard
                    </button>
                </div>
            );
        }

        // Some older sessions or server runs may not have `receivedQuestions` metadata
        // with explicit filenames. In that case, fall back to the default naming
        // convention used by the server: `Q{index}.webm` (1-based).
        const currentQFile = reviewData?.receivedQuestions?.[currentQIndex]?.filename;
        let currentVideoURL = null;
        if (currentQFile) {
            currentVideoURL = reviewData.videoBaseUrl + currentQFile;
        } else if (reviewData?.videoBaseUrl) {
            // Fallback to conventional filenames on disk
            currentVideoURL = reviewData.videoBaseUrl + `Q${currentQIndex + 1}.webm`;
        }

        // Handler: submit human review scores/comments for current question
        const handleScoreSubmit = async (e) => {
            e.preventDefault();
            const submitBtn = e.target.querySelector('button[type="submit"]');
            const originalText = submitBtn ? submitBtn.innerText : 'Submit';
            if (submitBtn) { submitBtn.innerText = 'Saving...'; submitBtn.disabled = true; }

            try {
                const payload = {
                    token: currentReviewSession.token || currentReviewSession.id,
                    question_index: currentQIndex,
                    clarity: clarityScore,
                    confidence: confidenceScore,
                    comment: comment
                };

                await callApi('/interviewer/submit-review', payload);

                setMessage(`✅ Success! Review for Q${currentQIndex + 1} saved to database.`);

                // Remove local draft and briefly toggle draft lock to refresh UI
                const draftKey = `draft_${payload.token}_Q${currentQIndex}`;
                localStorage.removeItem(draftKey);

                setIsDraftLoaded(false);
                setTimeout(() => setIsDraftLoaded(true), 50);

            } catch (error) {
                console.error("Submit failed:", error);
                setMessage(`❌ Error saving review: ${error.message}`);
            } finally {
                if (submitBtn) { submitBtn.innerText = originalText; submitBtn.disabled = false; }
            }
        };

        return (
            <div className="p-8 bg-white shadow-2xl rounded-xl w-full max-w-6xl">
            
                {/* Nút Back to Dashboard */}
                <button 
                    onClick={() => setView('admin_dashboard')}
                    className="flex items-center text-gray-500 hover:text-indigo-600 mb-4 transition-colors group"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 transform group-hover:-translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                    </svg>
                    <span className="font-semibold text-sm">Back to Dashboard</span>
                </button>

                <div className="flex justify-between items-center mb-6 border-b pb-4">
                    <h2 className="text-3xl font-extrabold text-gray-800">Review Session: {candidateName}</h2>
                    <div className="text-sm text-gray-500">Token: {tokenVal}</div>
                </div>

                {/* --- START: PHẦN SỬA ĐỔI THANH REVIEW Q1-Q5 --- */}
                <div className="mb-8">
                    <div className="flex justify-center items-center space-x-4 bg-gray-50 p-4 rounded-xl border border-gray-200">
                        <span className="text-sm font-bold text-gray-500 uppercase tracking-wider mr-2">
                            Select Question:
                        </span>
                        {/* Tạo vòng lặp cố định 5 lần cho 5 câu hỏi */}
                        {[0, 1, 2, 3, 4].map(index => {
                            // Kiểm tra xem câu này có dữ liệu video không (để đổi màu)
                            const hasData = reviewData?.availableQIndexes?.includes(index);
                            const isSelected = index === currentQIndex;

                            // Logic màu sắc: 
                            // - Đang chọn: Màu tím đậm (Indigo)
                            // - Có video (chưa chọn): Màu trắng viền tím
                            // - Không có video: Màu xám (Gray)
                            let btnClass = "w-12 h-12 flex items-center justify-center rounded-lg font-bold text-sm transition-all duration-200 border-2 ";
                            
                            if (isSelected) {
                                btnClass += "bg-indigo-600 text-white border-indigo-600 shadow-lg transform scale-110";
                            } else if (hasData) {
                                btnClass += "bg-white text-indigo-600 border-indigo-200 hover:border-indigo-500 hover:bg-indigo-50 cursor-pointer";
                            } else {
                                btnClass += "bg-gray-100 text-gray-400 border-transparent hover:bg-gray-200 cursor-pointer";
                            }

                            return (
                                <button
                                    key={index}
                                    onClick={() => setCurrentQIndex(index)}
                                    className={btnClass}
                                    title={hasData ? "View Recording" : "No Data Found"}
                                >
                                    Q{index + 1}
                                </button>
                            );
                        })}
                    </div>
                </div>
                {/* --- END: PHẦN SỬA ĐỔI --- */}

                {/* Review Grid: Video & Transcript */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Column 1: Video Player */}
                    <div className="lg:col-span-2">
                        <h3 className="text-xl font-bold text-gray-700 mb-3">Video Playback (Q{currentQIndex + 1})</h3>
                        <div className="w-full bg-black rounded-lg overflow-hidden border-4 border-indigo-400">
                            {currentVideoURL ? (
                                <video
                                    controls
                                    src={currentVideoURL}
                                    className="w-full h-auto object-contain"
                                    style={{ maxHeight: '60vh', width: '100%' }}
                                />
                            ) : (
                                <div className="p-10 text-center text-white">Video file not found or upload failed for Q{currentQIndex + 1}.</div>
                            )}
                        </div>
                    </div>

                    {/* Column 2: AI Transcript & Analysis */}
                    <div className="lg:col-span-1 space-y-4">
                        {/* Spacer to align panel top with video frame on large screens */}
                        <div className="hidden lg:block h-6" aria-hidden="true" />
                        
                        <div className="p-4 bg-gray-50 rounded-lg shadow-inner border border-gray-200">
                            <h4 className="text-lg font-bold text-indigo-700 mb-3 flex items-center justify-between">
                                <span>AI Analysis</span>
                                {/* Hiển thị Badge điểm số nếu đã có kết quả */}
                                {questionTranscript && questionTranscript !== "Processing..." && questionTranscript !== "Transcript not found for this question." && (
                                    <span className={`text-sm px-2 py-1 rounded-full text-white ${
                                        aiMatchScore >= 70 ? 'bg-green-600' : aiMatchScore >= 40 ? 'bg-yellow-500' : 'bg-red-500'
                                    }`}>
                                        Match Score: {aiMatchScore}%
                                    </span>
                                )}
                            </h4>

                            <div className="bg-white p-4 rounded border border-gray-100 shadow-sm">
                                {questionTranscriptLoading ? (
                                    <div className="flex items-center gap-2 text-indigo-500 italic py-4">
                                        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Fetching analysis...
                                    </div>
                                ) : (
                                    <>
                                        {/* TRƯỜNG HỢP 1: ĐANG XỬ LÝ (Processing) */}
                                        {questionTranscript === "Processing..." ? (
                                            <div className="flex flex-col gap-2 py-4 text-center">
                                                <span className="text-orange-600 font-medium animate-pulse text-lg">
                                                    ⏳ AI is analyzing content...
                                                </span>
                                                <span className="text-xs text-gray-500">
                                                    Transcribing audio, calculating match score, and generating feedback.
                                                </span>
                                            </div>
                                        ) : (
                                            /* TRƯỜNG HỢP 2: ĐÃ CÓ KẾT QUẢ */
                                            questionTranscript && questionTranscript !== "Transcript not found for this question." ? (
                                                <div className="space-y-4">
                                                    {/* 1. Match Score Visualization (Progress Bar) */}
                                                    <div>
                                                        <div className="flex justify-between text-xs font-semibold text-gray-500 mb-1">
                                                            <span>Relevance to Question</span>
                                                            <span>{aiMatchScore}/100</span>
                                                        </div>
                                                        <div className="w-full bg-gray-200 rounded-full h-2.5">
                                                            <div 
                                                                className={`h-2.5 rounded-full transition-all duration-1000 ease-out ${
                                                                    aiMatchScore >= 70 ? 'bg-green-500' : aiMatchScore >= 40 ? 'bg-yellow-400' : 'bg-red-500'
                                                                }`} 
                                                                style={{ width: `${aiMatchScore}%` }}
                                                            ></div>
                                                        </div>
                                                    </div>

                                                    <hr className="border-gray-100" />

                                                    {/* 2. Transcript Content */}
                                                    <div>
                                                        <h5 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Transcript</h5>
                                                        <div className="text-sm text-gray-800 whitespace-pre-wrap max-h-48 overflow-y-auto pr-1 leading-relaxed">
                                                            {questionTranscript}
                                                        </div>
                                                    </div>

                                                    {/* 3. AI Feedback Box (Chỉ hiện nếu có feedback) */}
                                                    {aiFeedback && (
                                                        <div className="mt-3 p-3 bg-indigo-50 border-l-4 border-indigo-500 rounded-r-md">
                                                            <h5 className="text-xs font-bold text-indigo-800 uppercase tracking-wider mb-1">AI Feedback</h5>
                                                            <p className="text-sm text-indigo-900 italic">
                                                                "{aiFeedback}"
                                                            </p>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : (
                                                /* TRƯỜNG HỢP 3: KHÔNG CÓ DỮ LIỆU */
                                                <div className="text-gray-400 italic py-4 text-center">
                                                    Analysis data not available.
                                                </div>
                                            )
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                        <div className="p-4 bg-gray-50 rounded-lg shadow-inner border border-gray-200">
                            <h4 className="text-lg font-bold text-indigo-700 mb-2">Emotion & Pace Scores</h4>
                            <p className="text-sm text-gray-600">
                                **Placeholder:** Advanced analysis of confidence, voice tone, and pace will be displayed here using structured JSON data from the server.
                            </p>
                            <ul className="text-xs mt-2 space-y-1">
                                <li>Confidence: <span className="font-bold text-green-600">85% (Simulated)</span></li>
                                <li>Pace: <span className="font-bold text-yellow-600">145 WPM (Simulated)</span></li>
                            </ul>
                        </div>
                    </div>
                </div>

                {/* Human Review Form */}
                <div className="mt-8 p-6 border-t border-gray-200">
                    <h3 className="text-xl font-bold text-gray-700 mb-4">Human Review & Scoring</h3>
                    <form onSubmit={handleScoreSubmit} className="space-y-4">
                        {/* Scores */}
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Clarity & Structure (1-10)</label>
                                <input type="range" min="1" max="10" value={clarityScore} onChange={(e) => setClarityScore(parseInt(e.target.value))} className="w-full" />
                                <span className="text-sm font-semibold text-indigo-600">{clarityScore}</span>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Confidence & Fluency (1-10)</label>
                                <input type="range" min="1" max="10" value={confidenceScore} onChange={(e) => setConfidenceScore(parseInt(e.target.value))} className="w-full" />
                                <span className="text-sm font-semibold text-indigo-600">{confidenceScore}</span>
                            </div>
                        </div>

                        {/* Comments */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700">Detailed Feedback/Comments</label>
                            <textarea
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                                rows="3"
                                className="mt-1 block w-full border border-gray-300 rounded-lg p-2 focus:ring-indigo-500 focus:border-indigo-500"
                                placeholder="Enter specific feedback on content, communication, or body language."
                            />
                        </div>
                        
                        <button type="submit" className="px-6 py-2 bg-indigo-600 text-white font-semibold rounded-lg shadow-md hover:bg-indigo-700 transition">
                            Submit Review for Q{currentQIndex + 1}
                        </button>
                    </form>
                </div>
            </div>
        );
    }


    // Final Completion Screen
    const renderComplete = () => (
        <div className="p-8 bg-white shadow-2xl rounded-xl w-full max-w-md text-center">
            <svg className="w-16 h-16 mx-auto mb-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            <h2 className="text-3xl font-extrabold text-gray-800 mb-2">Interview Complete!</h2>
            <p className="text-gray-600 mb-6">
                Thank you for completing the {MAX_QUESTIONS} questions.
            </p>
            <p className="text-sm font-medium text-gray-700">
                {message || 'Finalizing session on server...'}
            </p>
            
            {!sessionFinalized ? (
                <button 
                    onClick={handleFinishSession}
                    disabled={isLoading}
                    className={`mt-6 w-full py-3 px-4 border border-transparent rounded-lg shadow-md text-white font-semibold transition duration-300 
                        ${isLoading ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                >
                    {isLoading ? 'Finalizing...' : 'Submit & Finish Session'}
                </button>
            ) : (
                <button
                    onClick={handleReturnToLogin}
                    className="mt-6 w-full py-3 px-4 border border-indigo-600 rounded-lg shadow-sm text-indigo-700 font-semibold bg-white hover:bg-gray-50 transition"
                >
                    Return to Login Page
                </button>
            )}
        </div>
    );

    const renderInterview = () => {
        const questionNumber = currentQuestionIndex + 1;
        const currentQuestion = questions[currentQuestionIndex];
        
        // --- Button Logic based on recording state ---
        let primaryButton;
        
        if (mediaAccessStatus === 'granted' && questions.length > 0) {
            if (!isRecording && uploadStatus === 'idle') {
                primaryButton = (
                    <button 
                        onClick={startRecording}
                        className="px-8 py-4 bg-green-600 text-white font-bold text-lg rounded-xl shadow-xl hover:bg-green-700 transition transform hover:scale-105 disabled:opacity-50"
                        disabled={uploadStatus !== 'idle'}
                    >
                        Start Recording Q{questionNumber}
                    </button>
                );
            } else if (isRecording) {
                primaryButton = (
                    <button 
                        onClick={stopRecording}
                        className="px-8 py-4 bg-red-600 text-white font-bold text-lg rounded-xl shadow-xl hover:bg-red-700 transition transform hover:scale-105 animate-pulse"
                    >
                        Stop Recording
                    </button>
                );
            } else if (uploadStatus === 'stopped') {
                primaryButton = (
                    <button 
                        onClick={handleUploadVideo} 
                        className="px-8 py-4 bg-blue-600 text-white font-bold text-lg rounded-xl shadow-xl hover:bg-blue-700 transition transform hover:scale-105 disabled:opacity-50"
                        disabled={uploadStatus !== 'stopped'}
                    >
                        Upload Q{questionNumber} 
                    </button>
                );
            } else if (uploadStatus === 'uploading') {
                primaryButton = (
                    <button 
                        disabled
                        className="px-8 py-4 bg-yellow-500 text-white font-bold text-lg rounded-xl shadow-xl disabled:opacity-80"
                    >
                        Uploading...
                    </button>
                );
            } 
            else if (uploadStatus === 'failed') {
                primaryButton = (
                    <button
                        onClick={handleUploadVideo}
                        className="px-8 py-4 bg-red-500 text-white font-bold text-lg rounded-xl shadow-xl hover:bg-red-600 transition transform hover:scale-105"
                    >
                        Retry Upload
                    </button>
                );
            }
            else if (uploadStatus === 'success') {
                // --- ĐÂY LÀ PHẦN SỬA ĐỔI ---
                
                // Upload succeeded — AI runs in background on server. Allow user to move to the next question immediately.
                primaryButton = (
                    <button 
                        onClick={handleNextQuestion}
                        className="px-8 py-4 bg-indigo-600 text-white font-bold text-lg rounded-xl shadow-xl hover:bg-indigo-700 transition transform hover:scale-105"
                    >
                        {questionNumber < MAX_QUESTIONS ? `Next Question (${questionNumber + 1}/${MAX_QUESTIONS})` : 'Finish Session'}
                    </button>
                );
            }
        }
        
        // --- Media Content Rendering ---
        let mediaContent;

        if (mediaAccessStatus === 'pending') {
             mediaContent = (
                <div className="p-8 text-center text-indigo-500 h-96 flex flex-col justify-center items-center bg-gray-100 rounded-xl">
                    <div className="animate-spin inline-block w-8 h-8 border-4 border-indigo-300 border-t-indigo-600 rounded-full mb-3"></div>
                    <p className="font-semibold">Waiting for camera/microphone access...</p>
                </div>
            );
        } else if (mediaAccessStatus === 'denied') {
            mediaContent = (
                <div className="p-8 text-center text-red-600 h-96 flex flex-col justify-center items-center bg-red-50 rounded-xl border-2 border-red-300">
                    <svg className="w-12 h-12 mx-auto mb-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>
                    <p className="font-bold text-xl">Access Denied</p>
                    <p className="text-base text-gray-700 mt-2">Camera/Microphone access is mandatory to continue.</p>
                    <p className="text-xs text-gray-600">Check browser settings and ensure you are running on **localhost** or **HTTPS**.</p>
                    <button
                        onClick={requestMediaAccess}
                        className="mt-6 py-2 px-6 bg-red-600 text-white font-medium rounded-lg shadow-md hover:bg-red-700 transition"
                    >
                        Retry Access
                    </button>
                </div>
            );
        } else if (mediaAccessStatus === 'granted') {
            mediaContent = (
                <div className="relative w-full mx-auto bg-black rounded-xl overflow-hidden shadow-2xl">
                    <video
                        ref={videoRef}
                        autoPlay
                        muted
                        playsInline
                        className="w-full h-auto object-contain rounded-xl transform scale-x-[-1] border-4 border-indigo-500"
                        style={{ maxHeight: '60vh' }}
                    />
                    <div className={`absolute top-2 right-2 px-3 py-1 text-white text-xs font-bold rounded-full shadow-lg ${isRecording ? 'bg-red-600 animate-pulse' : 'bg-gray-700'}`}>
                        {isRecording ? 'RECORDING' : 'LIVE PREVIEW'}
                    </div>
                     <div className="absolute bottom-2 left-2 px-2 py-1 bg-black bg-opacity-70 text-gray-300 text-xs rounded">
                        Camera: {mediaStream?.getVideoTracks()[0]?.label || 'Active'}
                    </div>
                </div>
            );
        }

        return (
            <div className="p-8 bg-white shadow-2xl rounded-xl w-full max-w-6xl">
                <h2 className="text-3xl font-extrabold text-gray-800 mb-2 text-center">Interview Session</h2>
                <p className="text-gray-500 mb-8 text-center">
                    Welcome, {userName}. Answer the questions below. (Q{questionNumber} of {MAX_QUESTIONS})
                </p>
                
                <div className="flex flex-col lg:flex-row gap-8">
                    {/* Left Column: Video Preview */}
                    <div className="lg:w-2/3">
                        {mediaContent}
                    </div>

                    {/* Right Column: Question and Status */}
                    <div className="lg:w-1/3 space-y-4">
                        <div className="p-4 bg-indigo-50 rounded-lg shadow-inner min-h-[150px] flex flex-col justify-between">
                            <h3 className="font-bold text-lg text-indigo-700">Question #{questionNumber}:</h3>
                            <p className="text-gray-800 mt-2 font-medium">
                                {questions.length > 0 
                                    ? currentQuestion.text 
                                    : 'Loading questions... (Check Firestore/Admin Key)'
                                }
                            </p>
                            <p className="text-xs text-indigo-500 mt-2 self-end">
                                Topic: {questions.length > 0 ? currentQuestion.id.split('_')[0] : 'N/A'}
                            </p>
                        </div>
                        
                        {/* Session Status Panel (UPDATED FOR CIRCULAR METERS) */}
                        <div className="p-4 bg-gray-100 rounded-lg shadow-inner">
                            <h3 className="font-bold text-sm text-gray-600 mb-3">Session Status</h3>
                            <div className="flex justify-around items-center mb-4">
                                <TimerDisplay elapsedTime={elapsedTime} isRecording={isRecording} />
                                <VolumeMeter audioLevel={audioLevel} isRecording={isRecording} />
                            </div>

                            <div className="border-t border-gray-200 pt-3 text-xs text-gray-600">
                                <p>Folder: {folderName}</p>
                                <p className={`mt-1 font-semibold ${mediaAccessStatus === 'granted' ? 'text-green-600' : 'text-red-600'}`}>
                                    Media: {mediaAccessStatus.toUpperCase()}
                                </p>
                                <p className={`mt-1 font-semibold 
                                    ${isRecording ? 'text-red-600' : (uploadStatus === 'stopped' ? 'text-blue-600' : (uploadStatus === 'success' ? 'text-green-600' : 'text-gray-600'))}`}>
                                    Recording: {isRecording ? 'IN PROGRESS' : uploadStatus.toUpperCase()}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div className="mt-8 flex justify-center">
                    {primaryButton}
                </div>
                
                {message && <div className="mt-4 text-center text-sm font-medium text-gray-700">{message}</div>}
            </div>
        );
    };


    return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4 font-sans">
            {view === 'login' && renderLogin()}
            {view === 'admin_login' && renderInterviewerLogin()}
            {view === 'interview' && renderInterview()}
            {view === 'admin_dashboard' && renderInterviewerDashboard()}
            {view === 'admin_review' && renderReviewInterface()} 
            {view === 'complete' && renderComplete()}
        </div>
    );
};

export default App;