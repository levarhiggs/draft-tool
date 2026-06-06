import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            "AIzaSyDKufv12b6oVvtx7QLY6YYWa43XJAWgDTs",
  authDomain:        "csbc-2026-summer-draft.firebaseapp.com",
  projectId:         "csbc-2026-summer-draft",
  storageBucket:     "csbc-2026-summer-draft.firebasestorage.app",
  messagingSenderId: "113744416375",
  appId:             "1:113744416375:web:1197ec0a4f790a0f1e8072",
  measurementId:     "G-SFNNQH07NV"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
