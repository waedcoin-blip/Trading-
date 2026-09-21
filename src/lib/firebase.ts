import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

export const effectiveConfig = {
  apiKey: (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_API_KEY) || firebaseConfig.apiKey,
  authDomain: (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN) || firebaseConfig.authDomain,
  projectId: (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_PROJECT_ID) || firebaseConfig.projectId,
  storageBucket: (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_STORAGE_BUCKET) || firebaseConfig.storageBucket,
  messagingSenderId: (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_MESSAGING_SENDER_ID) || firebaseConfig.messagingSenderId,
  appId: (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_APP_ID) || firebaseConfig.appId,
  firestoreDatabaseId: (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_DATABASE_ID) || firebaseConfig.firestoreDatabaseId
};

const currentHost = typeof window !== 'undefined' ? window.location.hostname : 'SSR/Node';

console.log(`[AUTH Diagnostics]
  Host: ${currentHost}
  Firebase SDK Apps Existing: ${getApps().length}
  Project ID: ${effectiveConfig.projectId || 'MISSING'}
  Auth Domain: ${effectiveConfig.authDomain || 'MISSING'}
  API Key Configured: ${effectiveConfig.apiKey ? 'YES' : 'NO'}
`);

const app = getApps().length === 0 ? initializeApp(effectiveConfig) : getApps()[0];
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({
  prompt: 'select_account'
});

const databaseId =
  effectiveConfig.firestoreDatabaseId &&
  effectiveConfig.firestoreDatabaseId !== '(default)'
    ? effectiveConfig.firestoreDatabaseId
    : undefined;

export const db = databaseId
  ? getFirestore(app, databaseId)
  : getFirestore(app);


