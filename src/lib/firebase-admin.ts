import { initializeApp, cert, getApps, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

let adminApp: App | null = null;
let adminAuthInstance: Auth | null = null;
let adminFirestoreInstance: Firestore | null = null;
let isExplicitCredentialConfigured = false;

function getServiceAccountCredentials() {
  // Option 1: FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson && saJson.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(saJson);
      if (parsed.client_email && parsed.private_key) {
        return {
          credential: cert(parsed),
          projectId: parsed.project_id || firebaseConfig.projectId,
          clientEmail: parsed.client_email,
          hasPrivateKey: true,
          source: 'FIREBASE_SERVICE_ACCOUNT_JSON'
        };
      }
    } catch (err) {
      console.error('[FIREBASE] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err);
    }
  }

  // Option 2: Individual environment variables
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    firebaseConfig.projectId;

  if (clientEmail && rawPrivateKey) {
    const privateKey = rawPrivateKey.replace(/\\n/g, '\n');
    return {
      credential: cert({
        projectId,
        clientEmail,
        privateKey
      }),
      projectId,
      clientEmail,
      hasPrivateKey: true,
      source: 'FIREBASE_CLIENT_EMAIL_AND_KEY'
    };
  }

  return null;
}

const creds = getServiceAccountCredentials();

const hasProjectId = Boolean(process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId);
const hasClientEmail = Boolean(process.env.FIREBASE_CLIENT_EMAIL || (creds && creds.clientEmail));
const hasPrivateKey = Boolean(process.env.FIREBASE_PRIVATE_KEY || (creds && creds.hasPrivateKey));
const hasSaJson = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT);

console.log(`[FIREBASE] Configuration detected: ${creds ? 'YES' : 'NO'}`);
console.log(`[FIREBASE] Project ID configured: ${hasProjectId ? 'YES' : 'NO'}`);
console.log(`[FIREBASE] Client email configured: ${hasClientEmail ? 'YES' : 'NO'}`);
console.log(`[FIREBASE] Private key configured: ${hasPrivateKey ? 'YES' : 'NO'}`);
console.log(`[FIREBASE] Service account JSON configured: ${hasSaJson ? 'YES' : 'NO'}`);
console.log(`[FIREBASE] Explicit credentials configured: ${creds ? 'YES' : 'NO'}`);

if (creds) {
  try {
    if (getApps().length === 0) {
      adminApp = initializeApp({
        credential: creds.credential,
        projectId: creds.projectId
      });
    } else {
      adminApp = getApps()[0];
    }

    isExplicitCredentialConfigured = true;
    adminAuthInstance = getAuth(adminApp);

    const databaseId =
      firebaseConfig.firestoreDatabaseId &&
      firebaseConfig.firestoreDatabaseId !== '(default)'
        ? firebaseConfig.firestoreDatabaseId
        : undefined;

    adminFirestoreInstance = databaseId
      ? getFirestore(adminApp, databaseId)
      : getFirestore(adminApp);

    console.log(`[FIREBASE] Firebase Admin initialized successfully using ${creds.source}.`);
  } catch (err: any) {
    console.error('[FIREBASE] Initialization error:', err?.message || err);
    adminApp = null;
    adminAuthInstance = null;
    adminFirestoreInstance = null;
    isExplicitCredentialConfigured = false;
  }
} else {
  console.warn('[FIREBASE] ERROR: Firestore production credentials are not configured.');
  console.warn('[FIREBASE] Expected configured credential environment variables: FIREBASE_SERVICE_ACCOUNT_JSON OR (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).');
  console.warn('[FIREBASE] ADC fallback prevented. Operating in fallback mode (Firestore persistence disabled).');
}

export const adminAuth = adminAuthInstance as Auth;
export const adminFirestore = adminFirestoreInstance as Firestore;
export const isFirebaseConfigured = isExplicitCredentialConfigured;


