import React, { createContext, useContext, useEffect, useState } from 'react';
import { 
  User, 
  signInWithPopup, 
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { doc, getDoc, getDocFromServer } from 'firebase/firestore';
import { auth, googleAuthProvider, db as firestoreDb, effectiveConfig } from '../lib/firebase.ts';

interface AuthContextType {
  user: User | null;
  idToken: string | null;
  loading: boolean;
  isAuthenticating: boolean;
  authError: string | null;
  clearAuthError: () => void;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (e: string, p: string) => Promise<void>;
  signUpWithEmail: (e: string, p: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  idToken: null,
  loading: true,
  isAuthenticating: false,
  authError: null,
  clearAuthError: () => {},
  signInWithGoogle: async () => {},
  signInWithEmail: async () => {},
  signUpWithEmail: async () => {},
  signOut: async () => {},
});

function formatAuthError(error: any): string {
  const code = error?.code || '';
  switch (code) {
    case 'auth/popup-blocked':
      return 'Pop-up window was blocked by your browser. Please enable pop-ups or click Sign In again.';
    case 'auth/popup-closed-by-user':
      return 'Sign-in pop-up window was closed before completing authentication.';
    case 'auth/unauthorized-domain':
      return 'This domain is not authorized in Firebase Console -> Authentication -> Settings -> Authorized Domains.';
    case 'auth/operation-not-allowed':
      return 'Google Sign-In is disabled in Firebase Console -> Authentication -> Sign-in method -> Google.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with the same email address using a different sign-in credential.';
    case 'auth/auth-domain-config-error':
      return 'Firebase authDomain configuration error. Please check your Firebase project configuration.';
    case 'auth/invalid-api-key':
      return 'Firebase API key is invalid or restricted.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Invalid email address or password.';
    case 'auth/email-already-in-use':
      return 'An account with this email address already exists.';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters.';
    case 'auth/network-request-failed':
      return 'Network connection error during authentication.';
    default:
      return error?.message || 'Authentication failed. Please try again.';
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const clearAuthError = () => setAuthError(null);

  useEffect(() => {
    const currentHost = typeof window !== 'undefined' ? window.location.hostname : 'N/A';
    console.log(`[AUTH] Auth listener mounted | Host: ${currentHost} | Project: ${effectiveConfig.projectId}`);

    // Test Firestore connection safely
    async function testFirestoreConnection() {
      try {
        await getDoc(doc(firestoreDb, 'test', 'connection'));
        console.log('[Firestore] Connected to Firestore database successfully.');
      } catch (error) {
        try {
          await getDocFromServer(doc(firestoreDb, 'test', 'connection'));
          console.log('[Firestore] Connected to Firestore server successfully.');
        } catch (serverErr) {
          console.warn('[Firestore] Connection notice (cached/offline mode active):', serverErr);
        }
      }
    }
    testFirestoreConnection();

    // Check redirect sign-in result on mount if applicable
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          console.log(`[AUTH] Redirect sign-in result retrieved for user: ${result.user.email || result.user.uid}`);
        }
      })
      .catch((err) => {
        if (err && err.code !== 'auth/popup-closed-by-user') {
          console.warn('[AUTH] Redirect sign-in result check notice:', err?.code || err?.message || err);
        }
      });

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        console.log(`[AUTH] User state: Authenticated (${currentUser.email || currentUser.uid})`);
        try {
          const token = await currentUser.getIdToken();
          setIdToken(token);

          // Non-blocking sync user profile with backend
          fetch('/api/auth/sync', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
          }).catch((syncErr) => {
            console.warn('[AUTH] Backend sync notice:', syncErr?.message || syncErr);
          });
        } catch (err) {
          console.error('[AUTH] Error obtaining ID token:', err);
        }
      } else {
        console.log('[AUTH] User state: Unauthenticated');
        setIdToken(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    setIsAuthenticating(true);
    setAuthError(null);
    const host = typeof window !== 'undefined' ? window.location.hostname : 'N/A';
    console.log(`[AUTH] Starting Google Sign-In popup | Host: ${host} | Project: ${effectiveConfig.projectId}`);

    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const token = await cred.user.getIdToken();
      setIdToken(token);
      console.log(`[AUTH] Google Sign-In success: ${cred.user.email || cred.user.uid}`);
    } catch (err: any) {
      const code = err?.code || '';
      console.error(`[AUTH Diagnostics]
        Google Sign-In Error Code: ${code || 'UNKNOWN'}
        Error Message: ${err?.message || err}
        Current Host: ${host}
        Project ID: ${effectiveConfig.projectId}
        Auth Domain: ${effectiveConfig.authDomain}
        Auth SDK Initialized: ${auth ? 'YES' : 'NO'}
        Google Provider Initialized: ${googleAuthProvider ? 'YES' : 'NO'}
      `);

      if (code === 'auth/popup-blocked') {
        console.log('[AUTH] Popup blocked, attempting fallback to redirect flow...');
        try {
          await signInWithRedirect(auth, googleAuthProvider);
          return;
        } catch (redirectErr: any) {
          console.error(`[AUTH] Redirect fallback failed: ${redirectErr?.code || redirectErr?.message}`);
          setAuthError(formatAuthError(redirectErr));
        }
      } else {
        setAuthError(formatAuthError(err));
      }
    } finally {
      setIsAuthenticating(false);
    }
  };

  const signInWithEmail = async (email: string, pass: string) => {
    setIsAuthenticating(true);
    setAuthError(null);
    console.log('[AUTH] Sign-in attempt started (Email/Password)');

    try {
      const cred = await signInWithEmailAndPassword(auth, email, pass);
      const token = await cred.user.getIdToken();
      setIdToken(token);
      console.log(`[AUTH] Sign-in successful for user: ${cred.user.email || cred.user.uid}`);
    } catch (err: any) {
      console.error(`[AUTH] Sign-in failed: ${err?.code || err?.message}`);
      setAuthError(formatAuthError(err));
    } finally {
      setIsAuthenticating(false);
    }
  };

  const signUpWithEmail = async (email: string, pass: string) => {
    setIsAuthenticating(true);
    setAuthError(null);
    console.log('[AUTH] Registration attempt started (Email/Password)');

    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      const token = await cred.user.getIdToken();
      setIdToken(token);
      console.log(`[AUTH] Registration successful for user: ${cred.user.email || cred.user.uid}`);
    } catch (err: any) {
      console.error(`[AUTH] Registration failed: ${err?.code || err?.message}`);
      setAuthError(formatAuthError(err));
    } finally {
      setIsAuthenticating(false);
    }
  };

  const signOut = async () => {
    try {
      await firebaseSignOut(auth);
      setUser(null);
      setIdToken(null);
      console.log('[AUTH] Sign-out successful');
    } catch (err) {
      console.error('[AUTH] Sign-out error:', err);
    }
  };

  return (
    <AuthContext.Provider 
      value={{ 
        user, 
        idToken, 
        loading, 
        isAuthenticating, 
        authError, 
        clearAuthError, 
        signInWithGoogle, 
        signInWithEmail, 
        signUpWithEmail, 
        signOut 
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

