import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { LogIn, LogOut, User as UserIcon, X, Mail, Lock, AlertCircle, Loader2 } from 'lucide-react';

export const UserAuthButton: React.FC = () => {
  const { 
    user, 
    loading, 
    isAuthenticating, 
    authError, 
    clearAuthError, 
    signInWithGoogle, 
    signInWithEmail, 
    signUpWithEmail, 
    signOut 
  } = useAuth();

  const [showModal, setShowModal] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 bg-[#12161f] border border-[#1e2533] rounded">
        <span className="w-2 h-2 rounded-full bg-gray-500 animate-pulse" />
        <span>Auth...</span>
      </div>
    );
  }

  if (user) {
    return (
      <div className="flex items-center gap-2 bg-[#12161f] border border-[#1e2533] px-2.5 py-1 rounded">
        {user.photoURL ? (
          <img 
            src={user.photoURL} 
            alt={user.displayName || 'User'} 
            className="w-5 h-5 rounded-full object-cover border border-blue-500/30"
            referrerPolicy="no-referrer"
          />
        ) : (
          <UserIcon className="w-4 h-4 text-blue-400" />
        )}
        <span className="text-xs font-semibold text-gray-200 max-w-[120px] truncate" title={user.email || ''}>
          {user.displayName || user.email?.split('@')[0] || 'User'}
        </span>
        <button
          onClick={signOut}
          className="text-gray-400 hover:text-red-400 p-1 transition"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    if (isSignUp) {
      await signUpWithEmail(email, password);
    } else {
      await signInWithEmail(email, password);
    }
  };

  return (
    <>
      <button
        onClick={() => {
          clearAuthError();
          setShowModal(true);
        }}
        className="flex items-center gap-1.5 px-3 py-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 rounded text-xs font-semibold transition"
        title="Sign in or create account"
      >
        <LogIn className="w-3.5 h-3.5" />
        <span>Sign In</span>
      </button>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="relative w-full max-w-sm bg-[#12161f] border border-[#1e2533] rounded-xl p-5 shadow-2xl text-gray-200">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-[#1e2533] mb-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <LogIn className="w-4 h-4 text-blue-400" />
                {isSignUp ? 'Create an Account' : 'Sign In to Ultra Bot'}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-400 hover:text-white p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Error Banner */}
            {authError && (
              <div className="mb-4 p-3 bg-red-950/50 border border-red-500/30 rounded-lg text-xs text-red-300 flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{authError}</span>
                </div>
                <button onClick={clearAuthError} className="text-red-400 hover:text-red-200">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Google Sign In Button */}
            <button
              onClick={async () => {
                await signInWithGoogle();
                if (!authError) setShowModal(false);
              }}
              disabled={isAuthenticating}
              className="w-full mb-4 flex items-center justify-center gap-2 py-2 px-4 bg-white hover:bg-gray-100 text-gray-900 rounded-lg text-xs font-bold transition disabled:opacity-50"
            >
              {isAuthenticating ? (
                <Loader2 className="w-4 h-4 animate-spin text-gray-700" />
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                </svg>
              )}
              <span>Continue with Google</span>
            </button>

            <div className="relative my-4 flex items-center justify-center">
              <div className="border-t border-[#1e2533] w-full" />
              <span className="bg-[#12161f] px-2 text-[10px] uppercase text-gray-500 font-semibold absolute">Or with email</span>
            </div>

            {/* Email Form */}
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-gray-400 mb-1">Email Address</label>
                <div className="relative">
                  <Mail className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-2.5" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full bg-[#181e2a] border border-[#263042] rounded-lg pl-8 pr-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-gray-400 mb-1">Password</label>
                <div className="relative">
                  <Lock className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-2.5" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-[#181e2a] border border-[#263042] rounded-lg pl-8 pr-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isAuthenticating}
                className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isAuthenticating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isSignUp ? 'Create Account' : 'Sign In'}</span>
              </button>
            </form>

            {/* Switch Mode Toggle */}
            <div className="mt-4 text-center text-xs text-gray-400">
              {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
              <button
                onClick={() => {
                  clearAuthError();
                  setIsSignUp(!isSignUp);
                }}
                className="text-blue-400 hover:underline font-semibold ml-1"
              >
                {isSignUp ? 'Sign In' : 'Sign Up'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

